// lib/manifiesto-csv.ts
// =============================================================================
// AFA Transportes · Parser de manifiesto Excel/CSV
// Dependencias:  npm install xlsx
//   - xlsx (SheetJS) maneja .xlsx, .xls y .csv en una sola librería.
// =============================================================================

import * as XLSX from "xlsx";

export type PasajeroImportado = {
  nombre:   string;
  dni:      string;
  telefono: string | null;
  email:    string | null;
  empresa:  string | null;
  edad:     number | null;  // para la columna "Edad" del Manifiesto MTC
  asiento:  string | null;
  notas:    string | null;
  parada:   string | null;  // nombre de la parada donde aborda (para portal cliente)
};

export type ResultadoImport = {
  ok:       PasajeroImportado[];
  errores:  Array<{ fila: number; motivo: string; data: Record<string, unknown> }>;
  total:    number;
};

// Aliases tolerantes a errores tipográficos comunes en planillas reales
const COLUMNAS = {
  nombre:   ["nombre", "nombres", "nombre completo", "pasajero", "name", "full name"],
  dni:      ["dni", "doc", "documento", "id", "cedula", "cédula", "ci", "rut", "pasaporte"],
  telefono: ["telefono", "teléfono", "celular", "phone", "movil", "móvil", "whatsapp"],
  email:    ["email", "correo", "e-mail", "mail"],
  empresa:  ["empresa", "compañia", "compañía", "company", "organización", "organizacion"],
  edad:     ["edad", "edades", "años", "anos", "age", "edad (años)"],
  asiento:  ["asiento", "seat", "butaca"],
  notas:    ["notas", "observaciones", "obs", "comentarios", "notes"],
  parada:   ["parada", "paradero", "stop", "punto abordaje", "punto de abordaje", "lugar abordaje", "embarque", "subida"],
} as const;

function normaliza(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita tildes
}

function mapearColumnas(headers: string[]): Record<keyof typeof COLUMNAS, number | -1> {
  const norm = headers.map(normaliza);
  const out = {} as Record<keyof typeof COLUMNAS, number | -1>;
  (Object.keys(COLUMNAS) as Array<keyof typeof COLUMNAS>).forEach(k => {
    out[k] = norm.findIndex(h => (COLUMNAS[k] as readonly string[]).includes(h));
  });
  return out;
}

// Valida DNI peruano (8 dígitos) — flexible para CE/Pasaporte (alfanumérico hasta 12)
function validaDocumento(doc: string): boolean {
  const d = String(doc).trim();
  if (!d) return false;
  if (/^\d{8}$/.test(d)) return true;              // DNI peruano
  if (/^[A-Z0-9]{6,12}$/i.test(d)) return true;    // CE o pasaporte
  return false;
}

/**
 * Parsea un archivo (CSV o Excel) y devuelve los pasajeros validados.
 * Maneja saltos de fila vacíos y celdas con whitespace.
 */
export async function parsearManifiesto(file: File): Promise<ResultadoImport> {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: "array", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return { ok: [], errores: [{ fila: 0, motivo: "Archivo vacío o sin hoja válida", data: {} }], total: 0 };
  }

  // Convierte a array de arrays para detectar cabecera flexible
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  if (rows.length < 2) {
    return { ok: [], errores: [{ fila: 0, motivo: "El archivo no tiene filas de datos", data: {} }], total: 0 };
  }

  const headers = (rows[0] as unknown[]).map(h => String(h ?? ""));
  const idx     = mapearColumnas(headers);

  if (idx.nombre === -1 || idx.dni === -1) {
    return {
      ok: [],
      errores: [{
        fila: 1,
        motivo: `Faltan columnas obligatorias. Detectadas: [${headers.join(", ")}]. Se requieren al menos: Nombre, DNI`,
        data: { headers },
      }],
      total: 0,
    };
  }

  const ok:      PasajeroImportado[] = [];
  const errores: ResultadoImport["errores"] = [];
  const dnisVistos = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    if (!r || r.every(c => String(c ?? "").trim() === "")) continue;

    const get = (k: keyof typeof COLUMNAS) =>
      idx[k] >= 0 ? String(r[idx[k]] ?? "").trim() : "";

    const nombre = get("nombre");
    const dni    = get("dni");

    if (!nombre) {
      errores.push({ fila: i + 1, motivo: "Falta nombre", data: { row: r } });
      continue;
    }
    if (!validaDocumento(dni)) {
      errores.push({ fila: i + 1, motivo: `DNI inválido: "${dni}"`, data: { row: r } });
      continue;
    }
    if (dnisVistos.has(dni)) {
      errores.push({ fila: i + 1, motivo: `DNI duplicado en el archivo: ${dni}`, data: { row: r } });
      continue;
    }
    dnisVistos.add(dni);

    const edadRaw = get("edad");
    const edadNum = edadRaw ? parseInt(edadRaw, 10) : NaN;
    const edad    = Number.isFinite(edadNum) && edadNum >= 0 && edadNum <= 120 ? edadNum : null;

    ok.push({
      nombre,
      dni,
      telefono: get("telefono") || null,
      email:    get("email")    || null,
      empresa:  get("empresa")  || null,
      edad,
      asiento:  get("asiento")  || null,
      notas:    get("notas")    || null,
      parada:   get("parada")   || null,
    });
  }

  return { ok, errores, total: rows.length - 1 };
}

/**
 * Genera un archivo plantilla Excel para que el cliente lo descargue y llene.
 */
export function descargarPlantilla(): void {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Nombre", "DNI", "Teléfono", "Email", "Empresa", "Edad", "Asiento", "Notas"],
    ["Juan Pérez Quispe",      "12345678", "999111222", "juan@empresa.pe",  "ACME S.A.C.", "34", "A1", ""],
    ["María García Rodríguez", "87654321", "999333444", "maria@empresa.pe", "ACME S.A.C.", "29", "A2", "Vegetariano"],
  ]);
  // Anchos sugeridos
  (ws as any)["!cols"] = [
    { wch: 28 }, { wch: 10 }, { wch: 12 }, { wch: 24 }, { wch: 18 }, { wch: 6 }, { wch: 8 }, { wch: 24 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Manifiesto");
  XLSX.writeFile(wb, "plantilla_manifiesto_afa.xlsx");
}

/**
 * Plantilla para portal cliente — incluye columna Parada y hoja de referencia con paradas.
 * @param paradas - lista de paradas del servicio [{orden, nombre}]
 */
export function descargarPlantillaPortal(
  paradas: { orden: number; nombre: string }[]
): void {
  const wb = XLSX.utils.book_new();

  // Hoja 1: Plantilla de pasajeros
  const headerRow = ["Nombre", "DNI", "Empresa", "Edad", "Teléfono", "Parada"];
  const ejemplos = paradas.length > 0
    ? [
        ["Juan Pérez Quispe",      "12345678", "ACME S.A.C.", "34", "999111222", paradas[0]?.nombre || ""],
        ["María García Rodríguez", "87654321", "ACME S.A.C.", "29", "999333444", paradas[Math.min(1, paradas.length - 1)]?.nombre || ""],
      ]
    : [
        ["Juan Pérez Quispe",      "12345678", "ACME S.A.C.", "34", "999111222", ""],
        ["María García Rodríguez", "87654321", "ACME S.A.C.", "29", "999333444", ""],
      ];

  const ws1 = XLSX.utils.aoa_to_sheet([headerRow, ...ejemplos]);
  (ws1 as any)["!cols"] = [
    { wch: 30 }, { wch: 11 }, { wch: 22 }, { wch: 6 }, { wch: 13 }, { wch: 28 },
  ];
  XLSX.utils.book_append_sheet(wb, ws1, "Pasajeros");

  // Hoja 2: Paradas del servicio (referencia)
  if (paradas.length > 0) {
    const ws2 = XLSX.utils.aoa_to_sheet([
      ["Referencia de paradas — usa estos nombres exactos en la columna Parada"],
      [""],
      ["#", "Nombre de la parada"],
      ...paradas.map(p => [p.orden, p.nombre]),
    ]);
    (ws2 as any)["!cols"] = [{ wch: 6 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Paradas (referencia)");
  }

  XLSX.writeFile(wb, "plantilla_manifiesto_portal_afa.xlsx");
}