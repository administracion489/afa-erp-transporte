// ──────────────────────────────────────────────────────────────────────────────
// lib/seguros-inclusion.ts — Motor PURO: la lista que se le manda al bróker para INCLUIR personas
// en una póliza (SCTR Salud/Pensión, Vida Ley).
//
// Un trabajador nuevo entra SIN SCTR: se pide la inclusión al bróker y solo queda cubierto cuando
// la aseguradora la confirma (`seguro_cobertura.estado` 'solicitada' → 'incluida', lib/seguros.ts).
// El bróker pide siempre lo mismo y en una hoja: nombre, DNI, fecha de nacimiento, cargo y fecha de
// ingreso (el sueldo solo algunas aseguradoras, para la prima del SCTR: va opcional).
//
// La salida es TEXTO separado por tabulaciones (TSV): se pega directo en Excel o en el correo.
// Por eso ningún campo lleva una tabulación ni un salto de línea (partirían la fila), y las fechas
// van DD/MM/AAAA, como las lee el Excel peruano. Quien no tiene DNI o fecha de nacimiento SALE
// igual en la lista (el bróker necesita a todos) y además se NOMBRA en `faltan`: sin esos dos la
// aseguradora devuelve la inclusión, y eso se descubre días después.
// Matriz: npx tsx scripts/prueba-seguros.mts (sección de inclusiones)
// ──────────────────────────────────────────────────────────────────────────────

import { etiquetaDeTipos, tiposDePoliza, type PolizaRow } from "./seguros";

/** Lo que el lector trae de `conductores` / `personal_administrativo` (columnas reales). */
export type PersonaInclusion = {
  clase: "conductor" | "personal";
  id: number;
  nombre: string | null;
  dni?: string | null;
  fecha_nacimiento?: string | null;
  /** solo personal_administrativo; el conductor sale «Conductor» */
  cargo?: string | null;
  fecha_ingreso?: string | null;
  sueldo_basico?: number | string | null;
};

export type FaltaInclusion = { clase: "conductor" | "personal"; id: number; nombre: string; campos: string[] };

export type ListaInclusion = {
  /** cabecera + una fila por persona, separadas por \t y \n */
  tsv: string;
  /** quién no tiene DNI o fecha de nacimiento (sale en la lista igual, con la celda vacía) */
  faltan: FaltaInclusion[];
  /** «Inclusión al SCTR Salud + Pensión · póliza 123 · Rimac» para el asunto del correo */
  titulo: string;
  filas: number;
};

/** Sin tabulaciones, saltos ni espacios repetidos: un campo nunca parte la fila. */
export function limpiarCampo(v: unknown): string {
  return String(v ?? "").replace(/[\t\r\n\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function fechaDMA(v: unknown): string {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
}

function sueldo(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "";
}

export function listaInclusion(
  personas: PersonaInclusion[], poliza: PolizaRow | null, opts: { conSueldo?: boolean } = {},
): ListaInclusion {
  const cab = ["Nombre", "DNI", "Fecha de nacimiento", "Cargo", "Fecha de ingreso"];
  if (opts.conSueldo) cab.push("Sueldo");
  const lineas = [cab.join("\t")];
  const faltan: FaltaInclusion[] = [];
  for (const p of personas || []) {
    const nombre = limpiarCampo(p.nombre) || `#${p.id}`;
    const dni = limpiarCampo(p.dni);
    const nac = fechaDMA(p.fecha_nacimiento);
    const cargo = p.clase === "conductor" ? "Conductor" : limpiarCampo(p.cargo);
    const celdas = [nombre, dni, nac, cargo, fechaDMA(p.fecha_ingreso)];
    if (opts.conSueldo) celdas.push(sueldo(p.sueldo_basico));
    lineas.push(celdas.join("\t"));
    const campos: string[] = [];
    if (!dni) campos.push("DNI");
    if (!nac) campos.push("fecha de nacimiento");
    if (campos.length) faltan.push({ clase: p.clase, id: p.id, nombre, campos });
  }
  const tipos = poliza ? tiposDePoliza(poliza) : [];
  const partes = [`Inclusión${tipos.length ? ` al ${etiquetaDeTipos(tipos)}` : ""}`];
  if (poliza?.numero_poliza) partes.push(`póliza ${limpiarCampo(poliza.numero_poliza)}`);
  if (poliza?.aseguradora) partes.push(limpiarCampo(poliza.aseguradora));
  return { tsv: lineas.join("\n"), faltan, titulo: partes.join(" · "), filas: lineas.length - 1 };
}
