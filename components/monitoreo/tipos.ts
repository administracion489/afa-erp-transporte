// components/monitoreo/tipos.ts — la forma en que /monitoreo pasa una unidad a sus componentes.
// No decide nada: el estado de cada unidad lo da `juzgarUnidad` (lib/monitoreo-estado.ts).

import type { PosicionUnidad, VeredictoUnidad } from "@/lib/monitoreo-estado";

export type UnidadVista = {
  /** «p:ID» / «t:ID» (`claveUnidad`): la ÚNICA identidad de lista, marcador, KPI y centrar. */
  clave: string;
  placa: string;
  categoria: string | null;
  marca: string | null;
  modelo: string | null;
  esTercero: boolean;
  proveedor: string | null;
  posicion: PosicionUnidad | null;
  /** null mientras la primera lectura de posiciones no terminó: no se afirma nada todavía. */
  veredicto: VeredictoUnidad | null;
  /** El conductor de su última posición (nombre y teléfono resueltos del catálogo). */
  conductor: { nombre: string | null; telefono: string | null } | null;
  /** Del servicio que manda hoy (en curso, o el próximo del día); null sin servicio. */
  tipoServicio: "fijo" | "eventual" | null;
};

export type FiltroFlota = "todos" | "propia" | "tercero";
export type FiltroServicio = "todos" | "fijo" | "eventual";
