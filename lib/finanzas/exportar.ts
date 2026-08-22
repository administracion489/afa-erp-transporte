// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/exportar.ts — "Bajar" a Excel: exportación, plantillas y rechazos.
//
// El repo no tenía NINGÚN export en finanzas (ni /gastos, ni /finanzas, ni CxP).
// Este módulo es el lado espejo de lib/importador: lo que se sube se puede volver a
// bajar con las mismas cabeceras, de modo que el ciclo Google Sheets ↔ ERP cierra.
//
// Convenciones del repo que se respetan:
//   · PARSEAR con `xlsx` (import estático) · GENERAR con `xlsx-js-style` (import
//     dinámico, para no engordar el bundle) — documentado en lib/portal-usuarios-csv.ts.
//   · Navy de marca #0b315f en la cabecera, formato de moneda '"S/ "#,##0.00'.
//   · CSV siempre con BOM y con comillas escapadas (app/tarifario lo hace mal y se
//     rompe con cualquier campo que traiga una coma o una tilde).
// ──────────────────────────────────────────────────────────────────────────────

import type { FilaError } from "@/lib/importador/tabular";

const NAVY = "0B315F";
const GRIS_MUESTRA = "94A3B8";

/** ARGB para xlsx-js-style (siempre opaco). */
const A = (hex: string) => "FF" + hex.replace("#", "").toUpperCase();

export type TipoColumna = "texto" | "monto" | "fecha" | "numero" | "entero";

export type Columna<T> = {
  /** Cabecera tal como se quiere ver en el Excel (y como la reconoce el importador). */
  titulo: string;
  /** Cómo sacar el valor de la fila. */
  valor: (fila: T) => unknown;
  tipo?: TipoColumna;
  ancho?: number;
};

const FMT: Record<TipoColumna, string | undefined> = {
  texto: undefined,
  monto: '"S/ "#,##0.00',
  numero: "#,##0.00",
  entero: "0",
  fecha: "dd/mm/yyyy",
};

/**
 * Sanea un nombre de archivo (NFD → sin diacríticos → solo [A-Za-z0-9._-]).
 * Existía como helper LOCAL en app/documentos/page.tsx y reimplementado a medias en
 * otros dos sitios; aquí queda exportado de una vez.
 */
export function limpiarNombreArchivo(nombre: string): string {
  return String(nombre ?? "archivo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "archivo";
}

/** Fecha de hoy en Perú, para sufijar nombres de archivo. */
function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Convierte una fila del ERP en la celda que va al Excel. Las fechas se emiten como
 * Date real (no string) para que Excel/Sheets las reconozca y el usuario pueda
 * ordenarlas y filtrarlas; los montos como number, nunca como "S/ 1,234.56" texto.
 */
function celda(v: unknown, tipo: TipoColumna): unknown {
  if (v == null || v === "") return "";
  if (tipo === "monto" || tipo === "numero" || tipo === "entero") {
    const n = Number(v);
    return Number.isFinite(n) ? n : "";
  }
  if (tipo === "fecha") {
    const s = String(v).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(v);
    // Mediodía UTC evita que el desfase de zona corra el día una casilla atrás.
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  }
  return String(v);
}

export type OpcionesExport = {
  /** Nombre de archivo sin extensión. Se sanea y se le añade la fecha. */
  nombre: string;
  hoja?: string;
  /** Título en negrita sobre la cabecera (fila combinada). */
  titulo?: string | null;
  /** Línea de contexto bajo el título (filtros aplicados, periodo…). */
  subtitulo?: string | null;
  /** Fila de totales al pie para las columnas de tipo monto/numero. */
  totales?: boolean;
};

/**
 * Genera y descarga un .xlsx estilizado a partir de cualquier grilla del ERP.
 * Es la función que usan todas las pantallas nuevas para el botón "Descargar Excel".
 */
export async function exportarXlsx<T>(filas: T[], columnas: Columna<T>[], opts: OpcionesExport): Promise<void> {
  const mod: any = await import("xlsx-js-style");
  const XLSXS = mod.default ?? mod;

  const hayTitulo = !!opts.titulo;
  const haySub = !!opts.subtitulo;
  const filaCabecera = (hayTitulo ? 1 : 0) + (haySub ? 1 : 0);

  const aoa: unknown[][] = [];
  if (hayTitulo) aoa.push([opts.titulo]);
  if (haySub) aoa.push([opts.subtitulo]);
  aoa.push(columnas.map((c) => c.titulo));
  for (const f of filas) aoa.push(columnas.map((c) => celda(c.valor(f), c.tipo ?? "texto")));

  // Fila de totales: solo tiene sentido en columnas numéricas.
  if (opts.totales && filas.length) {
    const fila = columnas.map((c, i) => {
      const t = c.tipo ?? "texto";
      if (t !== "monto" && t !== "numero") return i === 0 ? "TOTAL" : "";
      return filas.reduce((s, f) => s + (Number(c.valor(f)) || 0), 0);
    });
    aoa.push(fila);
  }

  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  const nFilas = aoa.length;
  const nCols = columnas.length;

  // Anchos: por contenido, acotados entre lo declarado y un máximo razonable.
  ws["!cols"] = columnas.map((c, i) => {
    if (c.ancho) return { wch: c.ancho };
    let max = c.titulo.length;
    for (let r = filaCabecera + 1; r < nFilas; r++) {
      const v = aoa[r]?.[i];
      const len = v instanceof Date ? 10 : String(v ?? "").length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 9), 46) };
  });

  if (hayTitulo || haySub) {
    ws["!merges"] = [];
    if (hayTitulo) ws["!merges"].push({ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, nCols - 1) } });
    if (haySub) ws["!merges"].push({ s: { r: hayTitulo ? 1 : 0, c: 0 }, e: { r: hayTitulo ? 1 : 0, c: Math.max(0, nCols - 1) } });
  }

  const ref = (r: number, c: number) => XLSXS.utils.encode_cell({ r, c });

  if (hayTitulo && ws[ref(0, 0)]) {
    ws[ref(0, 0)].s = {
      font: { bold: true, sz: 14, color: { rgb: A(NAVY) } },
      alignment: { horizontal: "left", vertical: "center" },
    };
  }
  if (haySub) {
    const r = hayTitulo ? 1 : 0;
    if (ws[ref(r, 0)]) ws[ref(r, 0)].s = { font: { sz: 10, color: { rgb: A(GRIS_MUESTRA) } } };
  }

  // Cabecera navy con texto blanco.
  for (let c = 0; c < nCols; c++) {
    const cell = ws[ref(filaCabecera, c)];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, sz: 10, color: { rgb: A("FFFFFF") } },
      fill: { fgColor: { rgb: A(NAVY) } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
  }

  // Cuerpo: formato numérico y de fecha por columna.
  for (let r = filaCabecera + 1; r < nFilas; r++) {
    const esTotales = !!opts.totales && r === nFilas - 1 && filas.length > 0;
    for (let c = 0; c < nCols; c++) {
      const cell = ws[ref(r, c)];
      if (!cell) continue;
      const tipo = columnas[c].tipo ?? "texto";
      const numFmt = FMT[tipo];
      cell.s = {
        font: { sz: 10, bold: esTotales },
        alignment: { horizontal: tipo === "texto" ? "left" : "right", vertical: "center" },
        ...(numFmt ? { numFmt } : {}),
        ...(esTotales ? { fill: { fgColor: { rgb: A("EEF3F8") } } } : {}),
      };
      if (numFmt) cell.z = numFmt;
    }
  }

  ws["!autofilter"] = {
    ref: XLSXS.utils.encode_range({
      s: { r: filaCabecera, c: 0 },
      e: { r: Math.max(filaCabecera, nFilas - 1), c: Math.max(0, nCols - 1) },
    }),
  };

  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, (opts.hoja ?? "Datos").slice(0, 31));
  XLSXS.writeFile(wb, `${limpiarNombreArchivo(opts.nombre)}_${hoyLima()}.xlsx`);
}

/**
 * Descarga la PLANTILLA de un perfil de importación: hoja de datos con las cabeceras
 * y 2 filas de ejemplo en gris cursiva, más una hoja de instrucciones. Es lo que el
 * usuario pega en Google Sheets para llenar y volver a subir.
 */
export async function descargarPlantilla(args: {
  nombre: string;
  hoja?: string;
  cabeceras: string[];
  ejemplos?: unknown[][];
  instrucciones: string[];
}): Promise<void> {
  const mod: any = await import("xlsx-js-style");
  const XLSXS = mod.default ?? mod;

  const ejemplos = args.ejemplos ?? [];
  const aoa: unknown[][] = [args.cabeceras, ...ejemplos];
  const ws = XLSXS.utils.aoa_to_sheet(aoa);

  ws["!cols"] = args.cabeceras.map((h) => ({ wch: Math.min(Math.max(h.length + 4, 12), 32) }));
  const ref = (r: number, c: number) => XLSXS.utils.encode_cell({ r, c });

  for (let c = 0; c < args.cabeceras.length; c++) {
    const cell = ws[ref(0, c)];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, sz: 10, color: { rgb: A("FFFFFF") } },
      fill: { fgColor: { rgb: A(NAVY) } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
  }
  // Las filas de muestra van en gris cursiva para que se note que hay que borrarlas.
  for (let r = 1; r <= ejemplos.length; r++) {
    for (let c = 0; c < args.cabeceras.length; c++) {
      const cell = ws[ref(r, c)];
      if (!cell) continue;
      cell.s = { font: { sz: 10, italic: true, color: { rgb: A(GRIS_MUESTRA) } } };
    }
  }

  const wsInst = XLSXS.utils.aoa_to_sheet(args.instrucciones.map((l) => [l]));
  wsInst["!cols"] = [{ wch: 95 }];
  for (let r = 0; r < args.instrucciones.length; r++) {
    const cell = wsInst[ref(r, 0)];
    if (!cell) continue;
    const esTitulo = /^[A-ZÁÉÍÓÚÑ0-9 ·—-]+$/.test(args.instrucciones[r]) && args.instrucciones[r].length > 3;
    cell.s = { font: { sz: 10, bold: esTitulo, color: { rgb: A(esTitulo ? NAVY : "334155") } }, alignment: { wrapText: true, vertical: "top" } };
  }

  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, (args.hoja ?? "Datos").slice(0, 31));
  XLSXS.utils.book_append_sheet(wb, wsInst, "Instrucciones");
  XLSXS.writeFile(wb, `plantilla_${limpiarNombreArchivo(args.nombre)}.xlsx`);
}

/**
 * Descarga las filas RECHAZADAS por un import, con la fila original intacta más una
 * columna MOTIVO. El usuario corrige en Google Sheets y vuelve a subir solo eso —
 * hoy los errores se ven truncados a 10 en pantalla y no hay forma de recuperarlos.
 */
export async function descargarRechazos(args: {
  nombre: string;
  cabeceras: string[];
  errores: FilaError[];
}): Promise<void> {
  const mod: any = await import("xlsx-js-style");
  const XLSXS = mod.default ?? mod;

  const cabeceras = ["FILA", ...args.cabeceras, "MOTIVO DEL RECHAZO"];
  const aoa: unknown[][] = [cabeceras];
  for (const e of args.errores) {
    const raw = (e.raw ?? []) as unknown[];
    const fila: unknown[] = [e.fila];
    for (let i = 0; i < args.cabeceras.length; i++) fila.push(raw[i] ?? "");
    fila.push(e.motivo);
    aoa.push(fila);
  }

  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws["!cols"] = cabeceras.map((h, i) => ({
    wch: i === 0 ? 7 : i === cabeceras.length - 1 ? 60 : Math.min(Math.max(h.length + 4, 12), 30),
  }));

  const ref = (r: number, c: number) => XLSXS.utils.encode_cell({ r, c });
  for (let c = 0; c < cabeceras.length; c++) {
    const cell = ws[ref(0, c)];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, sz: 10, color: { rgb: A("FFFFFF") } },
      fill: { fgColor: { rgb: A(c === cabeceras.length - 1 ? "991B1B" : NAVY) } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
  }
  for (let r = 1; r < aoa.length; r++) {
    const cell = ws[ref(r, cabeceras.length - 1)];
    if (cell) cell.s = { font: { sz: 10, color: { rgb: A("991B1B") } }, alignment: { wrapText: true, vertical: "top" } };
  }

  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, "Rechazos");
  XLSXS.writeFile(wb, `rechazos_${limpiarNombreArchivo(args.nombre)}_${hoyLima()}.xlsx`);
}

/**
 * CSV con BOM y comillas escapadas. Útil cuando el destino es un import de Google
 * Sheets (que prefiere CSV) o un sistema que no lee xlsx.
 */
export function descargarCsv<T>(filas: T[], columnas: Columna<T>[], nombre: string): void {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lineas = [
    columnas.map((c) => esc(c.titulo)).join(","),
    ...filas.map((f) => columnas.map((c) => {
      const v = c.valor(f);
      const tipo = c.tipo ?? "texto";
      if (tipo === "monto" || tipo === "numero" || tipo === "entero") return esc(Number(v) || 0);
      if (tipo === "fecha") return esc(String(v ?? "").slice(0, 10));
      return esc(v);
    }).join(",")),
  ];
  // El BOM es obligatorio o Excel abre las tildes rotas.
  const blob = new Blob(["﻿" + lineas.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${limpiarNombreArchivo(nombre)}_${hoyLima()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Archivo de pago masivo para Telecrédito BCP. El formato exacto lo define el
 * convenio de cada empresa con el banco, así que se genera un CSV plano con las
 * columnas del abono y se documenta en la hoja: AFA debe cotejarlo una vez contra su
 * estructura y ajustar el orden si el banco lo pide distinto. No se inventa un
 * formato "oficial" que podría rebotar en la ventanilla.
 */
export type FilaAbono = {
  beneficiario: string;
  documento_identidad: string | null;
  banco: string | null;
  cuenta_destino: string | null;
  cci_destino: string | null;
  monto: number;
  moneda: string;
  referencia: string | null;
};

export function descargarArchivoTelecredito(filas: FilaAbono[], codigoLote: string): void {
  const columnas: Columna<FilaAbono>[] = [
    { titulo: "TIPO DOCUMENTO", valor: (f) => (String(f.documento_identidad ?? "").length === 11 ? "RUC" : "DNI") },
    { titulo: "NRO DOCUMENTO", valor: (f) => f.documento_identidad ?? "" },
    { titulo: "BENEFICIARIO", valor: (f) => f.beneficiario },
    { titulo: "BANCO", valor: (f) => f.banco ?? "" },
    { titulo: "NRO CUENTA", valor: (f) => f.cuenta_destino ?? "" },
    { titulo: "CCI", valor: (f) => f.cci_destino ?? "" },
    { titulo: "MONEDA", valor: (f) => (f.moneda === "USD" ? "USD" : "PEN") },
    { titulo: "IMPORTE", valor: (f) => f.monto, tipo: "monto" },
    { titulo: "REFERENCIA", valor: (f) => f.referencia ?? "" },
  ];
  descargarCsv(filas, columnas, `telecredito_${codigoLote}`);
}
