// lib/combustible-tipos.ts — El catálogo de tipos de combustible, en UN solo sitio.
//
// Vivía dentro de `app/combustible/page.tsx` como una const privada, así que ninguna otra
// pantalla podía nombrar un combustible con la misma etiqueta ni el mismo color. `/radar-ia`
// necesitaba justamente eso para su columna nueva, y copiarlo habría sido la tercera copia de
// una tabla de este módulo (`CAPACIDAD_TANQUE` ya está duplicada entre esa página y
// `lib/radar/acciones.ts`, con el comentario que lo confiesa).
//
// DOS COSAS QUE NO SON LO MISMO, y por eso hay `familia` además del tipo:
//   · el TIPO es el producto que se compró y es lo que se guarda y se muestra
//     (`gasolina_premium`);
//   · la FAMILIA es con qué se compara (`gasolina`): la capacidad del tanque, el precio
//     referencial y el rendimiento son de la familia, no del octanaje.
//
// `gasolina` a secas se conserva como LEGADO: son las filas que ya existen en `combustible` con
// ese valor. Quitarla las dejaría cayendo al fallback (diésel) y el histórico mentiría.

export type ConfigCombustible = {
  label: string;
  /** Para chips y columnas estrechas ("G. Premium"). */
  labelCorto: string;
  unidad: "galones" | "litros" | "m3";
  unidadLabel: string;
  icon: string;
  color: string;
  bg: string;
  precioRef: number;
  esAditivo: boolean;
  rendimientoLabel: string;
  /** Con qué se compara: capacidad de tanque, precio referencial, rendimiento. */
  familia: "diesel" | "gasolina" | "glp" | "gnv" | "urea" | "biodiesel";
  /**
   * Banda de PLAUSIBILIDAD FÍSICA del precio unitario, en la unidad canónica de la familia.
   *
   * NO es el precio de mercado —ese es `precios_combustible`, que AFA mantiene al día y contra
   * el que ya se juzga el ±20 %—. Esta banda contesta otra pregunta: **¿este número puede ser
   * un precio de ESTA unidad?** Un S/ 1.78 escrito en una fila de diésel y un S/ 25 en una de
   * GNV son órdenes de magnitud, no variaciones de mercado: lo que está mal es la unidad.
   *
   * Los límites no se midieron ni se heredan de otro módulo, y se declara: son deliberadamente
   * anchos —admiten con holgura todo lo que la flota ha pagado— y aun así lo bastante estrechos
   * para que el MISMO número expresado en otra unidad caiga fuera (un diésel a S/ 26/gal son
   * S/ 6.87/litro, por debajo del piso de 8). Ese es el único trabajo que hacen; el juicio fino
   * lo sigue haciendo el referencial.
   */
  rangoPrecio: { min: number; max: number };
  /** Valor histórico que sigue en la base pero ya no se propone de primera. */
  legado?: boolean;
};

export const COMBUSTIBLES: Record<string, ConfigCombustible> = {
  diesel:            { label: "Diésel",            labelCorto: "Diésel",      unidad: "galones", unidadLabel: "gal", icon: "🛢️", color: "#1d4ed8", bg: "#dbeafe", precioRef: 16.5, esAditivo: false, rendimientoLabel: "km/gal",  rangoPrecio: { min: 8, max: 45 }, familia: "diesel" },
  glp:               { label: "GLP",               labelCorto: "GLP",         unidad: "galones", unidadLabel: "gal", icon: "🔵", color: "#7c3aed", bg: "#ede9fe", precioRef: 7.65, esAditivo: false, rendimientoLabel: "km/gal",  rangoPrecio: { min: 3, max: 20 }, familia: "glp" },
  gnv:               { label: "GNV",               labelCorto: "GNV",         unidad: "m3",      unidadLabel: "m³",  icon: "💨", color: "#0f766e", bg: "#f0fdfa", precioRef: 1.78, esAditivo: false, rendimientoLabel: "km/m³",   rangoPrecio: { min: 0.8, max: 6 }, familia: "gnv" },
  gasolina_regular:  { label: "Gasolina regular",  labelCorto: "G. Regular",  unidad: "galones", unidadLabel: "gal", icon: "⛽", color: "#dc2626", bg: "#fee2e2", precioRef: 17.0, esAditivo: false, rendimientoLabel: "km/gal",  rangoPrecio: { min: 8, max: 45 }, familia: "gasolina" },
  gasolina_premium:  { label: "Gasolina premium",  labelCorto: "G. Premium",  unidad: "galones", unidadLabel: "gal", icon: "⛽", color: "#b91c1c", bg: "#fee2e2", precioRef: 19.5, esAditivo: false, rendimientoLabel: "km/gal",  rangoPrecio: { min: 8, max: 45 }, familia: "gasolina" },
  urea:              { label: "Urea (AdBlue)",     labelCorto: "Urea",        unidad: "litros",  unidadLabel: "lt",  icon: "🧪", color: "#854d0e", bg: "#fef9c3", precioRef: 5.50, esAditivo: true,  rendimientoLabel: "lt/100km", rangoPrecio: { min: 1.5, max: 20 }, familia: "urea" },
  biodiesel:         { label: "Biodiésel",         labelCorto: "Biodiésel",   unidad: "galones", unidadLabel: "gal", icon: "🌿", color: "#166534", bg: "#dcfce7", precioRef: 15.0, esAditivo: false, rendimientoLabel: "km/gal",  rangoPrecio: { min: 8, max: 45 }, familia: "biodiesel" },
  // Legado: las filas que ya están guardadas como "gasolina" sin grado. Se sigue pintando
  // igual; solo deja de ofrecerse cuando hay que ELEGIR uno (ver TIPOS_PARA_ELEGIR).
  gasolina:          { label: "Gasolina",          labelCorto: "Gasolina",    unidad: "galones", unidadLabel: "gal", icon: "⛽", color: "#dc2626", bg: "#fee2e2", precioRef: 18.0, esAditivo: false, rendimientoLabel: "km/gal",  rangoPrecio: { min: 8, max: 45 }, familia: "gasolina", legado: true },
};

/**
 * Litros por galón (US), para convertir una cantidad a la unidad de su familia.
 *
 * Vive aquí porque este catálogo es el dueño de `unidad` por tipo. Hace falta porque el
 * Radar guarda LITROS en la columna `combustible.galones` con `unidad: "litros"`
 * (lib/radar/acciones.ts) y quien calcula rendimiento tiene que mirarlo: sin convertir, un
 * diésel cargado en litros da un km/gal inflado ×3.785. La plata de esas filas está bien
 * (`total` = litros × precio/litro); lo único que hay que normalizar es la cantidad.
 *
 * El literal equivalente de lib/costeo-propio.ts NO se sustituye por éste: ese módulo está
 * congelado y scripts/prueba-costeo.mts lo compara al sexto decimal contra una copia literal.
 */
export const LITROS_POR_GALON = 3.785;

/** Todos los tipos, incluido el legado (para pintar cualquier fila guardada). */
export const TIPOS_COMBUSTIBLE = Object.keys(COMBUSTIBLES);

/** Los que se ofrecen al ELEGIR uno: sin los de legado, que ya no se deben escribir. */
export const TIPOS_PARA_ELEGIR = TIPOS_COMBUSTIBLE.filter((t) => !COMBUSTIBLES[t].legado);

/** Config de un tipo, con el diésel como respaldo (es el 90 % de la flota). */
export function configCombustible(tipo?: string | null): ConfigCombustible {
  const t = String(tipo ?? "").trim().toLowerCase();
  return COMBUSTIBLES[t] ?? COMBUSTIBLES.diesel;
}

/** La familia de un tipo: con qué comparar tanque, precio y rendimiento. */
export function familiaCombustible(tipo?: string | null): string {
  return configCombustible(tipo).familia;
}

// ── EL TANQUE DE LA UNIDAD ───────────────────────────────────────────────────
//
// SE DECLARA POR FAMILIA Y SE CONSULTABA POR TIPO. Ese desajuste estaba vivo en producción:
// `/vehiculos` escribe `capacidad_tanque` con las claves de la FAMILIA (`{diesel: 100,
// gasolina: 80}`) y los dos lectores —`getCapacidad` de /combustible y `capacidadTanque` de
// lib/radar/acciones.ts— buscaban por el TIPO leído del voucher. Con `diesel`, `glp`, `gnv` y
// `urea` la familia y el tipo se escriben igual y nadie lo notó; con `gasolina_regular` y
// `gasolina_premium` la capacidad editada **no se encontraba nunca** y el control caía a la
// heurística por categoría — que además, al no tener esa clave, remataba en `v.diesel`. O sea:
// una carga de gasolina en un bus se comparaba contra el tanque de DIÉSEL.
//
// Es el patrón que este repo ya pagó tres veces en un día (ver CLAUDE.md, "escribir con una
// identidad y leer con otra"), y por eso la resolución vive AQUÍ y en una sola función: quien
// escribe y quien lee derivan la clave por el mismo camino.
//
// NO ES UN "TIPO DE COMBUSTIBLE DEL VEHÍCULO". Un tanque declarado dice qué PUEDE cargar esa
// unidad y cuánto le entra; una unidad bicombustible declara dos y sigue sin afirmar qué se
// despachó en ningún voucher concreto. Esa distinción es la que impide que el ERP "corrija" un
// repostaje de gasolina al GLP de la ficha — ver `normalizarTipoCombustible` aquí abajo.

/**
 * Las familias que puede declarar un tanque, para la ficha de la unidad.
 *
 * DERIVADA del catálogo, nunca una lista aparte: `/vehiculos` llevaba su propia copia de cinco
 * filas escrita a mano, así que el día que el catálogo abrió la gasolina por octanaje las dos
 * dejaron de decir lo mismo. Deriva incluye `biodiesel`, que existe en el catálogo y no estaba
 * en esa copia.
 */
export const FAMILIAS_TANQUE: { familia: string; label: string; unidadLabel: string }[] = [
  ...new Set(TIPOS_COMBUSTIBLE.map((t) => COMBUSTIBLES[t].familia)),
].map((f) => ({ familia: f, label: configCombustible(f).label, unidadLabel: configCombustible(f).unidadLabel }));

/**
 * Capacidad estimada por CATEGORÍA de vehículo, cuando la unidad no declaró la suya.
 *
 * Estaba copiada LITERAL en `app/combustible/page.tsx` y en `lib/radar/acciones.ts` — la
 * cabecera de este archivo ya lo confesaba y nadie la había movido. Sus claves son FAMILIAS,
 * que es justo lo que el desajuste de arriba no respetaba.
 */
export const CAPACIDAD_TANQUE_CATEGORIA: Record<string, Record<string, number>> = {
  BUS:     { diesel: 100, gnv: 150, glp: 80,  gasolina: 80,  urea: 30 },
  MINIBUS: { diesel: 60,  gnv: 80,  glp: 50,  gasolina: 50,  urea: 15 },
  VAN:     { diesel: 20,  gnv: 40,  glp: 25,  gasolina: 20,  urea: 10 },
  AUTO:    { diesel: 12,  gnv: 30,  glp: 15,  gasolina: 12,  urea: 5  },
  DEFAULT: { diesel: 80,  gnv: 100, glp: 60,  gasolina: 60,  urea: 20 },
};

/** Lo que la unidad DECLARÓ para ese tipo, o null. Lo más específico gana. */
export function capacidadDeclarada(
  cap: Record<string, number> | null | undefined,
  tipo?: string | null
): number | null {
  if (!cap) return null;
  const positivo = (v: unknown) => (v != null && Number(v) > 0 ? Number(v) : null);
  // El TIPO exacto primero (una declaración más fina que la familia manda sobre ella), y
  // después la FAMILIA, que es como la escriben hoy las dos fichas de unidad.
  return positivo(cap[String(tipo ?? "").trim().toLowerCase()]) ?? positivo(cap[familiaCombustible(tipo)]);
}

/**
 * La capacidad con la que se juzga una carga: lo declarado por la unidad, y si no, el
 * estimado de su categoría. **Un solo sitio**, porque los dos lectores que había discrepaban
 * en cómo resolvían la clave y solo uno de los dos se arreglaría al tocar el otro.
 */
export function capacidadTanqueDe(
  veh: { categoria?: string | null; capacidad_tanque?: Record<string, number> | null } | string | null | undefined,
  tipo?: string | null
): number {
  const familia = familiaCombustible(tipo);
  if (veh && typeof veh === "object") {
    const declarada = capacidadDeclarada(veh.capacidad_tanque, tipo);
    if (declarada !== null) return declarada;
  }
  const categoria = typeof veh === "string" ? veh : veh?.categoria ?? "";
  const cat = String(categoria ?? "").toUpperCase();
  // POR LA CLAVE MÁS LARGA, no por el orden del objeto. `"MINIBUS".includes("BUS")` es true, y
  // como BUS venía primero en la tabla, TODO minibús se juzgaba contra el tanque de un bus —100
  // gal en vez de 60—, así que una carga de 70 gal en un minibús no levantaba nada. Es la misma
  // trampa que el match del grifo resolvió con "nunca contiene, exacto o con longitud mínima".
  const fila =
    Object.entries(CAPACIDAD_TANQUE_CATEGORIA)
      .filter(([k]) => k !== "DEFAULT" && cat.includes(k))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ??
    CAPACIDAD_TANQUE_CATEGORIA.DEFAULT;
  // Por FAMILIA, no por tipo: sin esto un `gasolina_premium` no encontraba clave y remataba
  // en el tanque de diésel, que en un bus son 100 gal contra los 80 que le tocan.
  return fila[familia] ?? fila.diesel ?? 80;
}

/** `{diesel:"100", glp:""}` → `{diesel:100}`; todo vacío → null (la columna es nullable). */
export function parseCapacidadTanque(cap: Record<string, string>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cap || {})) {
    const n = Number(v);
    if (v !== "" && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** El camino de vuelta, para llenar el formulario al editar. */
export function capacidadTanqueAForm(cap: Record<string, number> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cap || {})) out[k] = String(v);
  return out;
}

/**
 * ¿El error dice que `capacidad_tanque` no existe? (`radar-ia-combustible-multifoto.sql` sin correr).
 *
 * Existe para poder MANDAR SIEMPRE la columna y reintentar sin ella, en vez de mandarla solo
 * cuando trae valor. Esa segunda forma —la que tenía /vehiculos— protege la migración pero deja
 * un dato que NO SE PUEDE BORRAR: al vaciar los campos el payload deja de llevar la columna y la
 * capacidad vieja se queda escrita, así que un 80 tecleado por error es corregible a otro número
 * pero no retirable. Un formulario en el que un campo no se puede vaciar miente sobre lo guardado.
 */
export function faltaColumnaTanque(error: { message?: string } | null | undefined): boolean {
  const m = String(error?.message ?? "").toLowerCase();
  return m.includes("capacidad_tanque") && m.includes("does not exist");
}

// ── Normalización de lo que imprime un voucher ───────────────────────────────

/**
 * De la DESCRIPCIÓN DEL PRODUCTO de un voucher al tipo del catálogo. Devuelve null cuando no
 * hay señal: sin dato es mejor un hueco que un diésel inventado.
 *
 * **EL TIPO SALE DEL PRODUCTO, NUNCA DEL CÓDIGO DE UNIDAD.** En la nota de COESTI la línea es
 * `040002019 UGL 8.799x 24.640` seguida de `MAX-D DIESEL B5 S50 UV`: ahí `UGL` es la UNIDAD
 * (galones) de una venta de DIÉSEL. El prompt del Radar llegó a decir que "UGL" significaba
 * GLP, lo que convertía en GLP cada voucher de diésel de ese grifo.
 *
 * Octanaje peruano: 84 y 90 son regular, 95/97/98 son premium. Los grifos las venden como
 * "Gasohol 90", "G-95", "Primax 97" — el número es la señal fiable, la palabra comercial no.
 */
export function normalizarTipoCombustible(texto?: string | null): string | null {
  const t = String(texto ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!t.trim()) return null;

  // Aditivo primero: "UREA" puede aparecer junto al nombre del diésel en la misma boleta.
  if (/\b(UREA|ADBLUE|AD BLUE|DEF)\b/.test(t)) return "urea";
  if (/\b(GNV|GAS NATURAL)\b/.test(t)) return "gnv";
  // GLP: el producto, no la unidad. "UGL"/"U.GAL"/"GLN" son unidades y NO cuentan.
  if (/\b(GLP|GAS LICUADO|PROPANO)\b/.test(t)) return "glp";
  if (/\bBIODIESEL\b/.test(t)) return "biodiesel";
  // Diésel peruano: "MAX-D", "DB5", "B5 S50", "DIESEL", "PETROLEO".
  if (/\b(DIESEL|MAX ?-? ?D|DB5|B5|S50|PETROLEO)\b/.test(t)) return "diesel";

  if (/\b(GASOHOL|GASOLINA|GASOL)\b/.test(t) || /\bG ?-? ?(84|90|95|97|98)\b/.test(t)) {
    const octano = /\b(84|90|95|97|98)\b/.exec(t);
    if (octano) return Number(octano[1]) >= 95 ? "gasolina_premium" : "gasolina_regular";
    if (/\b(PREMIUM|SUPER|SUPREMO)\b/.test(t)) return "gasolina_premium";
    if (/\bREGULAR\b/.test(t)) return "gasolina_regular";
    return "gasolina"; // gasolina sin grado legible: el legado, no se inventa el octanaje
  }
  if (/\b(PREMIUM|SUPER)\b/.test(t)) return "gasolina_premium";
  return null;
}

// ── EL PUENTE CON `precios_combustible` ──────────────────────────────────────
//
// EL ERROR QUE ESTO MATA, Y LLEVABA MESES VIVO: `precios_combustible.tipo` guarda la etiqueta
// capitalizada y CON TILDE (`Diésel`, `Biodiésel`), y los dos sitios que la cruzaban contra
// `combustible.tipo_combustible` (minúscula y sin tilde) comparaban con un simple
// `.toLowerCase()`. `"diésel" !== "diesel"`, así que para el DIÉSEL:
//
//   · `lib/radar/acciones.ts` resolvía `pRef = 0` y el control de precio ±20 % **nunca se
//     aplicó a ninguna carga de diésel** — ni él ni `revisarTipoContraPrecio`, que también
//     recibe esas filas;
//   · `sincronizarPrecioDesdeCarga` lo salvaba con un `MAPA_TIPO` escrito a mano, que era una
//     TERCERA lista de tipos y ya se había quedado atrás: `gasolina_regular` y
//     `gasolina_premium` no estaban, así que una carga de gasolina por octanaje no actualizaba
//     el precio vigente que lee el Cotizador.
//
// Es *escribir con una identidad y leer con otra* otra vez, y la salida es la de siempre: UNA
// derivación de la clave, la del catálogo. `normalizarTipoCombustible` ya sabía hacerlo —lee
// "Diésel", "GLP", "Gasohol 90"— y nadie la había apuntado a esta tabla. Por eso no hace falta
// ninguna columna nueva ni ninguna migración: la etiqueta ya contiene su propio código.

/** El código del catálogo que le corresponde a una etiqueta de `precios_combustible.tipo`. */
export function tipoDeEtiquetaPrecio(etiqueta?: string | null): string | null {
  return normalizarTipoCombustible(etiqueta);
}

export type FilaPrecioRef = { tipo: string; precio: number };

/**
 * La fila de `precios_combustible` que le toca a un tipo de carga. **Lo más específico gana**,
 * igual que en `capacidadDeclarada`: primero el tipo exacto (`gasolina_premium` si alguien dio
 * de alta esa fila) y después la FAMILIA (`Gasolina`), que es como está cargada hoy la tabla.
 *
 * Devuelve la fila y no solo el número para que quien escriba sepa a cuál actualizar, y quien
 * lea pueda decir contra qué comparó.
 */
export function filaPrecioReferencial<T extends FilaPrecioRef>(
  filas: readonly T[] | null | undefined,
  tipo?: string | null
): { fila: T; exacto: boolean } | null {
  if (!filas?.length) return null;
  const buscado = String(tipo ?? "").trim().toLowerCase();
  const familia = familiaCombustible(tipo);
  let porFamilia: T | null = null;
  for (const f of filas) {
    const cod = tipoDeEtiquetaPrecio(f.tipo);
    if (!cod) continue;
    if (buscado && cod === buscado) return { fila: f, exacto: true };
    if (!porFamilia && familiaCombustible(cod) === familia) porFamilia = f;
  }
  return porFamilia ? { fila: porFamilia, exacto: false } : null;
}

/** El precio referencial de un tipo, o 0 si la tabla no lo tiene (como antes). */
export function precioReferencialDe(
  filas: readonly FilaPrecioRef[] | null | undefined,
  tipo?: string | null
): number {
  const r = filaPrecioReferencial(filas, tipo);
  return r ? Number(r.fila.precio) || 0 : 0;
}

// ── ¿ESTE NÚMERO PUEDE SER UN PRECIO DE ESTA UNIDAD? ─────────────────────────

/** Factor para pasar de la unidad de una fila a la unidad canónica de su familia. */
export function factorAUnidadCanonica(unidadFila: string | null | undefined, tipo?: string | null): number | null {
  const canonica = configCombustible(tipo).unidad;
  const u = String(unidadFila ?? "").trim().toLowerCase();
  if (!u) return 1;                        // sin declarar: se asume la canónica, como en todo el ERP
  if (u === canonica) return 1;
  if (u === "litros" && canonica === "galones") return LITROS_POR_GALON;   // S//lt → S//gal
  if (u === "galones" && canonica === "litros") return 1 / LITROS_POR_GALON;
  return null;                             // m³ no se convierte a nada: es otra magnitud
}

export type VeredictoPrecioUnidad =
  | { estado: "ok" }
  | { estado: "sin_base"; motivo: "sin_precio" | "unidad_desconocida" }
  /** El precio no cabe en la banda de la unidad declarada, pero sí en la de OTRA. Es exacto. */
  | { estado: "parece_otra_unidad"; unidadProbable: "galones" | "litros"; detalle: string }
  /** Fuera de banda y sin otra unidad que lo explique. */
  | { estado: "fuera_de_banda"; min: number; max: number; detalle: string };

/**
 * El control de unidad del punto E del plan: **avisa, nunca bloquea**.
 *
 * Lo que lo hace útil es que la banda se aplica en la unidad DE LA FILA, no en la del catálogo:
 * con eso deja de ser un "está caro" y pasa a decir *«esto parece un precio por litro y la fila
 * dice galones»*, que es exacto y accionable. El caso al revés (galones declarado litros) sale
 * por el mismo camino.
 *
 * No sustituye al ±20 % contra `precios_combustible`: ese juzga el MERCADO y se mueve todos los
 * meses; éste juzga la MAGNITUD y no se mueve nunca. Son dos preguntas distintas y las dos hacen
 * falta — el caso GLP↔litros solo lo ve el referencial, y el caso GNV↔galón solo lo ve la banda.
 */
export function revisarPrecioUnitario(args: {
  tipo?: string | null;
  precio: number | null | undefined;
  /** `combustible.unidad` de la fila. Vacío = la canónica de la familia. */
  unidad?: string | null;
}): VeredictoPrecioUnidad {
  const precio = Number(args.precio);
  if (!Number.isFinite(precio) || precio <= 0) return { estado: "sin_base", motivo: "sin_precio" };

  const cfg = configCombustible(args.tipo);
  const factor = factorAUnidadCanonica(args.unidad, args.tipo);
  if (factor === null) return { estado: "sin_base", motivo: "unidad_desconocida" };

  // La banda, expresada en la unidad de la FILA.
  const min = cfg.rangoPrecio.min / factor;
  const max = cfg.rangoPrecio.max / factor;
  if (precio >= min && precio <= max) return { estado: "ok" };

  const uFila = String(args.unidad ?? "").trim().toLowerCase() || cfg.unidad;
  const etiqueta = (u: string) => (u === "m3" ? "m³" : u === "litros" ? "litro" : "galón");

  // ¿Cabe en la banda de la OTRA unidad de la misma familia? Solo galones↔litros: el m³ es otra
  // magnitud y no se convierte, así que ahí nunca se afirma cuál sería la unidad correcta.
  for (const otra of ["galones", "litros"] as const) {
    if (otra === uFila || cfg.unidad === "m3") continue;
    const f = factorAUnidadCanonica(otra, args.tipo);
    if (f === null) continue;
    const lo = cfg.rangoPrecio.min / f;
    const hi = cfg.rangoPrecio.max / f;
    if (precio >= lo && precio <= hi) {
      return {
        estado: "parece_otra_unidad",
        unidadProbable: otra,
        detalle:
          `S/ ${precio.toFixed(2)} está fuera de lo que cuesta un ${etiqueta(uFila)} de ${cfg.label} ` +
          `(S/ ${min.toFixed(2)}–${max.toFixed(2)}), pero encaja como precio por ${etiqueta(otra)} ` +
          `(S/ ${lo.toFixed(2)}–${hi.toFixed(2)}). Revisa la unidad de la carga.`,
      };
    }
  }

  return {
    estado: "fuera_de_banda",
    min, max,
    detalle:
      `S/ ${precio.toFixed(2)} por ${etiqueta(uFila)} no es un precio posible de ${cfg.label} ` +
      `(S/ ${min.toFixed(2)}–${max.toFixed(2)}). Revisa el tipo de combustible y la unidad.`,
  };
}

/**
 * La unidad con la que se GUARDA una carga. **Se deriva del producto, no se elige.**
 *
 * Es el punto B del plan de unidades: `combustible.unidad` se persiste por fila —aunque sea
 * derivable— para que un cambio futuro de convención no reinterprete el histórico, y su valor
 * sale del catálogo, que es el único sitio que sabe en qué se vende cada combustible.
 *
 * La ÚNICA excepción es real y hay que conservarla: un producto de familia galonera puede venir
 * despachado en litros y el voucher lo dice. Eso no es una convención, es un hecho del papel.
 *
 * EL FALLO QUE CIERRA: `registrarCombustible` del Radar escribía `esLitros ? "litros" :
 * "galones"` **para todo**, así que cada carga de GNV que entraba por WhatsApp quedaba rotulada
 * en GALONES con un número que son METROS CÚBICOS. El GNV es ~70 % de la flota, y con la unidad
 * mal escrita ni el rendimiento ni la banda de precio pueden juzgarla. El formulario de
 * /combustible ya lo hacía bien (`cambiarTipo` copia `cfg.unidad`); el que faltaba era el Radar.
 */
export function unidadDeCarga(
  tipo?: string | null,
  declarada?: string | null
): "galones" | "litros" | "m3" {
  const canonica = configCombustible(tipo).unidad;
  const d = String(declarada ?? "").trim().toLowerCase();
  // Un gas no se vende por litro en Perú: si el producto es de m³, manda el m³ pase lo que pase.
  if (canonica === "m3") return "m3";
  if (d === "litros" || d === "lt") return "litros";
  if (d === "galones" || d === "gal") return "galones";
  return canonica;
}
