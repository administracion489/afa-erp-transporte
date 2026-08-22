// ──────────────────────────────────────────────────────────────────────────────
// lib/importador/tabular.ts — Núcleo compartido para leer Excel/CSV/Google Sheets.
//
// Hoy el repo tiene CUATRO normalizadores de cabecera distintos e incompatibles
// (paradas-csv, manifiesto-csv, manifiesto-unificado-csv, portal-usuarios-csv), dos
// parsers de coordenada byte-por-byte idénticos y ningún parser de FECHA ni de IMPORTE.
// Este módulo es la versión buena, extraída y endurecida:
//
//   · normHeader/scoreMatch/mapearColumnas — el algoritmo por PUNTAJE de
//     portal-usuarios-csv (exacto > palabra completa > nada), que evita que el alias
//     "id" cace dentro de "apellidos". Asignación exclusiva 1 columna ↔ 1 campo.
//   · PERFILES — un archivo puede venir en varios formatos (tradicional vs OSLO).
//     `detectarPerfil()` puntúa las cabeceras contra cada perfil y elige el mejor,
//     en vez de abortar el archivo entero como hacen los parsers actuales.
//   · parsearFecha — maneja el SERIAL de Excel (45000), ISO, dd/mm/aaaa y dd-mm-aa.
//     Es la brecha más peligrosa que había: hoy nadie convierte seriales.
//   · parsearMonto — "S/ 1,234.56", "1.234,56", "(500.00)" → number. Hoy el único
//     precedente (`Number(x) || 0`) devuelve 0 en silencio ante miles con coma.
//
// REGLA DE FECHAS DEL ERP: Perú es UTC-5 y no se usa toISOString() para "hoy".
// Aquí las fechas se devuelven como "YYYY-MM-DD" (fecha civil, sin hora ni zona),
// que es lo que guardan las columnas `date` de Postgres.
// ──────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Resultado unificado de cualquier importación. Reemplaza las 4 variantes sueltas. */
export type ResultadoImport<T> = {
  ok: T[];
  errores: FilaError[];
  /** Filas de datos leídas (sin contar la cabecera ni las vacías). */
  total: number;
  /** Perfil que se aplicó, cuando la lectura fue con `leerConPerfil`. */
  perfil?: string;
  /** Cabeceras crudas tal como venían en el archivo (para depurar mapeos). */
  cabeceras?: string[];
  /** Campos del perfil que no se pudieron mapear a ninguna columna. */
  camposSinMapear?: string[];
};

export type FilaError = {
  /** Número de fila tal como lo ve el usuario en Excel (1 = cabecera). */
  fila: number;
  motivo: string;
  /** La fila original, para poder exportar el reporte de rechazos. */
  raw?: unknown[];
};

/** Un campo del perfil: a qué columna del ERP va y con qué nombres puede venir. */
export type CampoPerfil = {
  /** Nombre canónico (normalmente la columna de Postgres). */
  campo: string;
  /** Alias en minúscula y sin tildes. La normalización baja todo, así que un Google
   *  Sheet con "N° FACTURA" en mayúsculas y con tilde matchea con "n factura". */
  alias: string[];
  /** Si falta, la fila se rechaza. */
  requerido?: boolean;
  tipo?: "texto" | "numero" | "monto" | "fecha" | "booleano";
};

export type Perfil<T> = {
  clave: string;
  nombre: string;
  descripcion?: string;
  campos: CampoPerfil[];
  /** Convierte una fila ya mapeada en la entidad final. Devuelve el error como string. */
  construir: (v: ValoresFila, ctx: ContextoPerfil) => T | string;
};

/** Acceso tipado a los valores ya mapeados de una fila. */
export type ValoresFila = {
  /** Texto crudo recortado de la celda del campo (o "" si no existe). */
  texto: (campo: string) => string;
  /** Importe parseado; null si la celda está vacía o no es un número. */
  monto: (campo: string) => number | null;
  /** Fecha "YYYY-MM-DD"; null si vacía o ilegible. */
  fecha: (campo: string) => string | null;
  numero: (campo: string) => number | null;
  booleano: (campo: string) => boolean | null;
  /** ¿La columna existe en el archivo? (distinto de "existe pero vacía"). */
  tiene: (campo: string) => boolean;
  fila: number;
  raw: unknown[];
};

/** Catálogos que el perfil puede necesitar para resolver referencias por nombre. */
export type ContextoPerfil = Record<string, unknown>;

// ── Normalización de cabeceras ────────────────────────────────────────────────

/**
 * Minúsculas, sin acentos, sin espacios de borde.
 * El rango de marcas diacríticas va ESCAPADO a propósito: en lib/portal-usuarios-csv.ts
 * está escrito con los combining marks literales en el fuente, invisible en el editor
 * y frágil ante cualquier renormalización del archivo.
 */
export function normaliza(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Cabecera normalizada para comparar: todo lo que no sea alfanumérico colapsa a un
 * espacio, de modo que "N° Documento", "N.DOCUMENTO" y "nro_documento" convergen.
 */
export function normHeader(s: unknown): string {
  return normaliza(s).replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Puntaje de coincidencia entre una cabecera normalizada y un alias.
 *   igualdad exacta        → 1000 + longitud (gana siempre)
 *   alias como PALABRA     → 100 + longitud
 *   nada                   → 0
 * Nunca por substring suelto: así "id" no caza dentro de "apellidos".
 */
export function scoreMatch(nh: string, alias: string): number {
  const a = normHeader(alias);
  if (!a || !nh) return 0;
  if (nh === a) return 1000 + a.length;
  const palabras = nh.split(" ");
  const aPalabras = a.split(" ");
  // El alias completo aparece como secuencia de palabras dentro de la cabecera.
  for (let i = 0; i + aPalabras.length <= palabras.length; i++) {
    if (aPalabras.every((w, j) => palabras[i + j] === w)) return 100 + a.length;
  }
  return 0;
}

/**
 * Resuelve columna ↔ campo por puntaje descendente, con asignación EXCLUSIVA:
 * cada columna se usa una sola vez y cada campo toma una sola columna.
 * Devuelve el índice de columna por campo (-1 = no encontrada).
 */
export function mapearColumnas(cabeceras: unknown[], campos: CampoPerfil[]): Record<string, number> {
  const nh = cabeceras.map(normHeader);
  const candidatos: { campo: string; col: number; score: number }[] = [];

  for (const c of campos) {
    for (let col = 0; col < nh.length; col++) {
      if (!nh[col]) continue;
      let mejor = 0;
      for (const alias of c.alias) {
        const s = scoreMatch(nh[col], alias);
        if (s > mejor) mejor = s;
      }
      if (mejor > 0) candidatos.push({ campo: c.campo, col, score: mejor });
    }
  }

  candidatos.sort((a, b) => b.score - a.score);
  const mapa: Record<string, number> = {};
  for (const c of campos) mapa[c.campo] = -1;
  const colUsada = new Set<number>();

  for (const cand of candidatos) {
    if (mapa[cand.campo] !== -1) continue;
    if (colUsada.has(cand.col)) continue;
    mapa[cand.campo] = cand.col;
    colUsada.add(cand.col);
  }
  return mapa;
}

// ── Parsers de tipo ───────────────────────────────────────────────────────────

/**
 * Importe → number. Acepta lo que sale de un Google Sheet peruano:
 *   "S/ 1,234.56" · "1.234,56" · "1 234,56" · "(500.00)" (negativo contable) · "1234.5"
 * Devuelve null si la celda está vacía o no contiene ningún dígito: quien llama
 * decide si eso es un error de fila. NUNCA devuelve 0 en silencio.
 */
export function parsearMonto(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  let s = String(v).trim();
  if (!s) return null;

  // Negativo contable entre paréntesis.
  let negativo = false;
  if (/^\(.*\)$/.test(s)) {
    negativo = true;
    s = s.slice(1, -1);
  }

  // Fuera símbolos de moneda, espacios (incl. no-rompibles) y el signo, que se
  // reintroduce al final.
  s = s.replace(/[Ss]\/\.?|PEN|USD|\$|\u00a0/g, "").trim();
  if (s.startsWith("-")) {
    negativo = true;
    s = s.slice(1);
  }
  s = s.replace(/\s/g, "");
  if (!/\d/.test(s)) return null;

  const tieneComa = s.includes(",");
  const tienePunto = s.includes(".");

  if (tieneComa && tienePunto) {
    // El separador decimal es el ÚLTIMO que aparece.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (tieneComa) {
    // "1,234" es ambiguo: con exactamente 3 dígitos detrás se asume separador de
    // miles (formato peruano/EEUU); si no, es el decimal (formato europeo).
    const partes = s.split(",");
    if (partes.length === 2 && partes[1].length === 3 && partes[0].length <= 3) s = s.replace(",", "");
    else if (partes.length > 2) s = s.replace(/,/g, "");
    else s = s.replace(",", ".");
  }

  s = s.replace(/[^0-9.]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

/** Entero/decimal simple (galones, cantidades). Mismo criterio que parsearMonto. */
export function parsearNumero(v: unknown): number | null {
  return parsearMonto(v);
}

/**
 * Fecha → "YYYY-MM-DD" (fecha civil, sin zona horaria).
 * Acepta:
 *   · Date (celda leída con cellDates)
 *   · SERIAL de Excel: 45000 → días desde 1899-12-30 (la brecha crítica que faltaba)
 *   · ISO "2026-08-21" o "2026-08-21T..."
 *   · "21/08/2026", "21-08-2026", "21.08.26"  (día primero, convención peruana)
 *   · "2026/08/21" (si el primer bloque tiene 4 dígitos, es el año)
 * Devuelve null si no logra interpretarla — nunca inventa una fecha.
 */
export function parsearFecha(v: unknown): string | null {
  if (v == null) return null;

  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${dosDig(v.getMonth() + 1)}-${dosDig(v.getDate())}`;
  }

  // Serial de Excel. El rango útil evita confundir "2026" (un año suelto) con un serial.
  if (typeof v === "number" && Number.isFinite(v)) {
    return desdeSerialExcel(v);
  }

  const s = String(v).trim();
  if (!s) return null;

  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const iso = desdeSerialExcel(n);
    if (iso) return iso;
  }

  // ISO (con o sin hora).
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) return armarFecha(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Separadores / - .
  const m = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[T\s].*)?$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let c = Number(m[3]);
    if (m[1].length === 4) return armarFecha(a, b, c);      // aaaa/mm/dd
    if (c < 100) c += c < 70 ? 2000 : 1900;                  // aa → 20aa / 19aa
    return armarFecha(c, b, a);                              // dd/mm/aaaa (Perú)
  }

  return null;
}

function dosDig(n: number): string {
  return String(n).padStart(2, "0");
}

function armarFecha(anio: number, mes: number, dia: number): string | null {
  if (!(anio >= 1900 && anio <= 2200)) return null;
  if (!(mes >= 1 && mes <= 12)) return null;
  if (!(dia >= 1 && dia <= 31)) return null;
  // Rechaza 31/02 y compañía comprobando el ida y vuelta.
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${anio}-${dosDig(mes)}-${dosDig(dia)}`;
}

/**
 * Serial de Excel → fecha civil. La época es 1899-12-30 (Excel cree que 1900 fue
 * bisiesto). Se acota a [1, 80000] ≈ 1900-2119 para no tragarse un año suelto.
 */
export function desdeSerialExcel(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 80000) return null;
  const dias = Math.floor(n);
  const ms = Date.UTC(1899, 11, 30) + dias * 86400000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${dosDig(d.getUTCMonth() + 1)}-${dosDig(d.getUTCDate())}`;
}

/** "SI"/"NO"/"X"/"TRUE"/"1" → boolean. null si no se reconoce. */
export function parsearBooleano(v: unknown): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = normaliza(v);
  if (["si", "s", "x", "true", "verdadero", "1", "sí"].includes(s)) return true;
  if (["no", "n", "false", "falso", "0"].includes(s)) return false;
  return null;
}

// ── Validadores del dominio peruano ───────────────────────────────────────────

/** RUC: 11 dígitos que empiezan en 10/15/16/17/20. Devuelve limpio o null. */
export function parsearRuc(v: unknown): string | null {
  const s = String(v ?? "").replace(/\D/g, "");
  if (s.length !== 11) return null;
  if (!/^(10|15|16|17|20)/.test(s)) return null;
  return s;
}

/** DNI (8 dígitos) o CE/pasaporte (alfanumérico 6-12). */
export function parsearDocumento(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return s;
  if (/^\d{11}$/.test(s)) return s; // un RUC también es documento válido
  if (/^[A-Z0-9]{6,12}$/.test(s)) return s;
  return null;
}

/** Placa peruana: ABC-123, A1B-234, ABC123. Devuelve normalizada con guion. */
export function parsearPlaca(v: unknown): string | null {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 5 || s.length > 7) return null;
  if (!/^[A-Z0-9]+$/.test(s)) return null;
  // Formato usual: 3 caracteres + 3 dígitos.
  if (s.length === 6) return `${s.slice(0, 3)}-${s.slice(3)}`;
  return s;
}

/** CCI: exactamente 20 dígitos. */
export function parsearCci(v: unknown): string | null {
  const s = String(v ?? "").replace(/\D/g, "");
  return s.length === 20 ? s : null;
}

/** Número de cuenta bancaria: 10-20 dígitos, se conserva con guiones fuera. */
export function parsearCuenta(v: unknown): string | null {
  const s = String(v ?? "").replace(/[^\d]/g, "");
  return s.length >= 8 && s.length <= 20 ? s : null;
}

/** Serie-número de comprobante: "F001-1234", "E001 567", "FACTURA F001-00001234". */
export function parsearComprobante(v: unknown): { serie: string | null; numero: string | null } {
  const s = String(v ?? "").toUpperCase().trim();
  if (!s) return { serie: null, numero: null };
  const m = s.match(/\b([A-Z]{1,4}\d{2,4})\s*[-–—\s]\s*(\d{1,8})\b/);
  if (m) return { serie: m[1], numero: String(Number(m[2])) };
  const soloNumero = s.match(/^(\d{1,10})$/);
  if (soloNumero) return { serie: null, numero: String(Number(soloNumero[1])) };
  return { serie: null, numero: s.slice(0, 40) };
}

// ── Lectura del archivo ───────────────────────────────────────────────────────

export type FilasCrudas = {
  cabeceras: unknown[];
  filas: unknown[][];
  /** Índice (0-based) de la fila de cabecera dentro de la hoja. */
  filaCabecera: number;
  hoja: string;
};

/** Tope defensivo: un histórico enorme congela la pestaña si se parsea entero. */
export const MAX_FILAS = 20000;

/**
 * Lee la primera hoja (o la indicada) como array de arrays y localiza la cabecera.
 * A diferencia de los parsers actuales, NO asume que la cabecera es la fila 1: los
 * Google Sheets reales suelen traer un título y una fila en blanco arriba.
 */
export async function leerArchivo(file: File, opts?: { hoja?: string }): Promise<FilasCrudas> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const nombreHoja = opts?.hoja && wb.Sheets[opts.hoja] ? opts.hoja : wb.SheetNames[0];
  const sheet = wb.Sheets[nombreHoja];
  if (!sheet) throw new Error("El archivo no tiene ninguna hoja legible.");

  const todas = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: true,
  }) as unknown[][];

  if (!todas.length) throw new Error("El archivo está vacío.");

  // La cabecera es, entre las primeras 15 filas, la que tenga más celdas de texto
  // no numérico: así se salta títulos ("REPORTE DE PROVEEDORES") y filas sueltas.
  let filaCabecera = 0;
  let mejor = -1;
  for (let i = 0; i < Math.min(15, todas.length); i++) {
    const fila = todas[i] ?? [];
    const puntaje = fila.filter((c) => {
      const s = String(c ?? "").trim();
      return s.length > 1 && !/^-?[\d.,\s]+$/.test(s);
    }).length;
    if (puntaje > mejor) {
      mejor = puntaje;
      filaCabecera = i;
    }
  }

  const cabeceras = (todas[filaCabecera] ?? []).map((c) => String(c ?? "").trim());
  const filas = todas.slice(filaCabecera + 1).filter(
    (r) => r && r.some((c) => String(c ?? "").trim() !== "")
  );

  if (filas.length > MAX_FILAS) {
    throw new Error(
      `El archivo tiene ${filas.length.toLocaleString("es-PE")} filas y el máximo es ${MAX_FILAS.toLocaleString("es-PE")}. Divídelo en partes.`
    );
  }

  return { cabeceras, filas, filaCabecera, hoja: nombreHoja };
}

// ── Perfiles ──────────────────────────────────────────────────────────────────

export type PuntajePerfil = { clave: string; nombre: string; puntaje: number; requeridosFaltantes: string[] };

/**
 * Puntúa qué tan bien encajan las cabeceras con cada perfil. El puntaje es la
 * proporción de campos REQUERIDOS encontrados (peso 3) más los opcionales (peso 1).
 * Sirve para elegir automáticamente entre "formato tradicional" y "formato OSLO".
 */
export function puntuarPerfiles<T>(cabeceras: unknown[], perfiles: Perfil<T>[]): PuntajePerfil[] {
  return perfiles
    .map((p) => {
      const mapa = mapearColumnas(cabeceras, p.campos);
      let puntaje = 0;
      let maximo = 0;
      const faltantes: string[] = [];
      for (const c of p.campos) {
        const peso = c.requerido ? 3 : 1;
        maximo += peso;
        if (mapa[c.campo] >= 0) puntaje += peso;
        else if (c.requerido) faltantes.push(c.campo);
      }
      return {
        clave: p.clave,
        nombre: p.nombre,
        puntaje: maximo ? puntaje / maximo : 0,
        requeridosFaltantes: faltantes,
      };
    })
    .sort((a, b) => b.puntaje - a.puntaje);
}

/** Elige el perfil con mejor puntaje que además tenga todos sus requeridos. */
export function detectarPerfil<T>(cabeceras: unknown[], perfiles: Perfil<T>[]): Perfil<T> | null {
  const rank = puntuarPerfiles(cabeceras, perfiles);
  const ganador = rank.find((r) => r.requeridosFaltantes.length === 0 && r.puntaje > 0.3);
  return ganador ? perfiles.find((p) => p.clave === ganador.clave) ?? null : null;
}

/**
 * Aplica un perfil a las filas crudas. `sobrescribirMapa` permite que la UI corrija
 * a mano un mapeo mal detectado (campo → índice de columna) sin tocar el perfil.
 */
export function aplicarPerfil<T>(
  crudas: FilasCrudas,
  perfil: Perfil<T>,
  ctx: ContextoPerfil = {},
  sobrescribirMapa?: Record<string, number>
): ResultadoImport<T> {
  const mapa = { ...mapearColumnas(crudas.cabeceras, perfil.campos), ...(sobrescribirMapa ?? {}) };
  const errores: FilaError[] = [];
  const ok: T[] = [];

  const camposSinMapear = perfil.campos.filter((c) => (mapa[c.campo] ?? -1) < 0).map((c) => c.campo);
  const requeridosFaltantes = perfil.campos
    .filter((c) => c.requerido && (mapa[c.campo] ?? -1) < 0)
    .map((c) => c.campo);

  if (requeridosFaltantes.length) {
    return {
      ok: [],
      total: crudas.filas.length,
      perfil: perfil.clave,
      cabeceras: crudas.cabeceras.map(String),
      camposSinMapear,
      errores: [
        {
          fila: crudas.filaCabecera + 1,
          motivo:
            `Faltan columnas obligatorias: ${requeridosFaltantes.join(", ")}. ` +
            `Detectadas en el archivo: [${crudas.cabeceras.filter(Boolean).join(", ")}]`,
        },
      ],
    };
  }

  crudas.filas.forEach((raw, i) => {
    // Número tal como lo ve el usuario en Excel (la cabecera es filaCabecera+1).
    const fila = crudas.filaCabecera + 2 + i;
    const celda = (campo: string): unknown => {
      const col = mapa[campo] ?? -1;
      return col >= 0 ? raw[col] : undefined;
    };

    const v: ValoresFila = {
      fila,
      raw,
      tiene: (campo) => (mapa[campo] ?? -1) >= 0,
      texto: (campo) => String(celda(campo) ?? "").trim(),
      monto: (campo) => parsearMonto(celda(campo)),
      numero: (campo) => parsearNumero(celda(campo)),
      fecha: (campo) => parsearFecha(celda(campo)),
      booleano: (campo) => parsearBooleano(celda(campo)),
    };

    try {
      const r = perfil.construir(v, ctx);
      if (typeof r === "string") errores.push({ fila, motivo: r, raw });
      else ok.push(r);
    } catch (e: unknown) {
      errores.push({ fila, motivo: String((e as Error)?.message ?? e), raw });
    }
  });

  return {
    ok,
    errores,
    total: crudas.filas.length,
    perfil: perfil.clave,
    cabeceras: crudas.cabeceras.map(String),
    camposSinMapear,
  };
}

/** Atajo: leer el archivo, detectar el perfil y aplicarlo. */
export async function leerConPerfil<T>(
  file: File,
  perfiles: Perfil<T>[],
  ctx: ContextoPerfil = {},
  perfilForzado?: string
): Promise<ResultadoImport<T>> {
  const crudas = await leerArchivo(file);
  const perfil = perfilForzado
    ? perfiles.find((p) => p.clave === perfilForzado) ?? null
    : detectarPerfil(crudas.cabeceras, perfiles);

  if (!perfil) {
    const rank = puntuarPerfiles(crudas.cabeceras, perfiles);
    const mejor = rank[0];
    return {
      ok: [],
      total: crudas.filas.length,
      cabeceras: crudas.cabeceras.map(String),
      errores: [
        {
          fila: crudas.filaCabecera + 1,
          motivo:
            `No se reconoció el formato del archivo. El más parecido es "${mejor?.nombre ?? "—"}" ` +
            `(${Math.round((mejor?.puntaje ?? 0) * 100)}% de coincidencia) y le faltan: ` +
            `${mejor?.requeridosFaltantes.join(", ") || "—"}. ` +
            `Cabeceras detectadas: [${crudas.cabeceras.filter(Boolean).join(", ")}]`,
        },
      ],
    };
  }

  return aplicarPerfil(crudas, perfil, ctx);
}

// ── Google Sheets sin credenciales ────────────────────────────────────────────

/**
 * Convierte el enlace de un Google Sheet en su URL de exportación CSV.
 * Requiere que la hoja esté compartida como "cualquiera con el enlace puede ver"
 * (no hace falta service account ni OAuth). Devuelve null si el enlace no es un
 * Sheet reconocible.
 *
 * Acepta:
 *   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=123
 *   https://docs.google.com/spreadsheets/d/<ID>/edit?gid=123
 */
export function urlCsvDeGoogleSheet(url: string): string | null {
  const m = String(url ?? "").match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const id = m[1];
  const gid = String(url).match(/[#?&]gid=(\d+)/)?.[1];
  const base = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  return gid ? `${base}&gid=${gid}` : base;
}

/**
 * Descarga un Google Sheet público como File, para pasárselo a `leerArchivo`.
 * Lanza un error legible si la hoja no es pública (Google responde con el HTML de
 * login en vez del CSV).
 */
export async function descargarGoogleSheet(url: string, nombre = "google-sheet.csv"): Promise<File> {
  const csvUrl = urlCsvDeGoogleSheet(url);
  if (!csvUrl) throw new Error("El enlace no parece ser una hoja de Google Sheets.");

  const res = await fetch(csvUrl);
  if (!res.ok) {
    throw new Error(
      `No se pudo leer la hoja (HTTP ${res.status}). Compártela como "Cualquier persona con el enlace · Lector".`
    );
  }
  const texto = await res.text();
  if (/<!DOCTYPE html|<html/i.test(texto.slice(0, 200))) {
    throw new Error(
      'La hoja no es pública: Google devolvió su página de acceso. En Google Sheets: Compartir → "Cualquier persona con el enlace" → Lector.'
    );
  }
  return new File([texto], nombre, { type: "text/csv" });
}
