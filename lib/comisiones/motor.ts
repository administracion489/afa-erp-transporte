// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/motor.ts — Orquesta todo lo ya sembrado y devuelve las líneas con traza.
//
// PURO. No lee la base, no mira el reloj: recibe los servicios eventuales, los contratos
// fijos, el bono de atención y la lista de operadores corroborados, y devuelve el conjunto
// de `LineaComision`. De dónde salen esos datos lo resuelve quien tiene acceso a la base,
// igual que `calcularCostoUnidad` recibe los parámetros ya resueltos.
//
// EL MOTOR ES LA ÚNICA COMPUERTA que conoce al cliente, así que es quien aplica las dos
// reglas de elegibilidad al eventual (las sub-reglas de `eventual.ts`/`fijo.ts` ya reciben
// lo gateado):
//   1. ¿Está cobrado? (defensivo: la frontera ya filtró, pero si algo se cuela no se paga.)
//   2. ¿Es cliente nuevo? (no está en lista firmada ∧ sin servicio en los 12 meses previos.)
//   3. ¿Dentro de la ventana de 12 meses desde el primer servicio cobrado?
// Lo que no pasa una compuerta sale como una línea con monto 0 y su código —para que sea
// trazable— pero NO cuenta para el tramo ni para el fondo.
//
// EL ANCLA DE LA VENTANA es por cliente: la fecha de servicio del primer servicio cobrado
// del cliente, mirando eventuales Y meses de fijo. Así el eventual y el fijo del mismo
// cliente comparten la misma ventana.
// ──────────────────────────────────────────────────────────────────────────────

import { comisionarEventuales } from "./eventual";
import { comisionarFijo } from "./fijo";
import { comisionarBonoAtencion, type Indicador } from "./bono-atencion";
import { comisionarFondo, type AporteFondo } from "./fondo-admin";
import {
  esClienteNuevo,
  dentroDeVentana,
  type ContextoCliente,
} from "./cliente-nuevo";
import { parametrosVigentes } from "./parametros";
import {
  type ContratoFijo,
  type LineaComision,
  type ParametroComision,
  type ResultadoComisiones,
  type ServicioEventual,
} from "./tipos";

export type EntradaBonoAtencion = {
  indicadores: readonly Indicador[];
  /** Fecha de cobro/cierre con la que se elige el parámetro vigente (tope, tolerancia). */
  fecha: string;
};

export type EntradaMotor = {
  parametros: readonly ParametroComision[];
  vendedorId?: string;
  eventuales?: readonly ServicioEventual[];
  contratosFijos?: readonly ContratoFijo[];
  bonoAtencion?: EntradaBonoAtencion | null;
  /** Operadores corroborados por el administrador, para repartir el fondo. */
  operadoresCorroborados?: readonly string[];
  /** Contexto por cliente (lista firmada, servicios previos, fecha de cotización, ancla). */
  clientes?: Record<string, ContextoCliente>;
};

/** El ancla de la ventana de un cliente: su `primerServicioCobradoFecha` explícito, o el
 *  mínimo de fechas de servicio de sus servicios cobrados (eventuales + meses de fijo). */
function anclaDeCliente(
  clienteId: string,
  ctx: ContextoCliente | undefined,
  eventuales: readonly ServicioEventual[],
  fijos: readonly ContratoFijo[],
): string | null {
  if (ctx?.primerServicioCobradoFecha != null) return ctx.primerServicioCobradoFecha;
  const fechas: string[] = [];
  for (const e of eventuales) {
    if (e.clienteId === clienteId && e.cobrado !== false) fechas.push(e.fechaServicio);
  }
  for (const c of fijos) {
    if (c.clienteId !== clienteId) continue;
    for (const m of c.meses) if (m.cobrado) fechas.push(m.fechaServicio);
  }
  if (!fechas.length) return null;
  return fechas.reduce((min, f) => (f < min ? f : min), fechas[0]);
}

export function calcularComisiones(entrada: EntradaMotor): ResultadoComisiones {
  const {
    parametros,
    vendedorId,
    eventuales = [],
    contratosFijos = [],
    bonoAtencion = null,
    operadoresCorroborados = [],
    clientes = {},
  } = entrada;

  const lineas: LineaComision[] = [];
  const elegibles: ServicioEventual[] = [];
  const aportesFondo: AporteFondo[] = [];

  // ── Eventuales: compuertas de elegibilidad ──
  for (const s of eventuales) {
    // 1. Cobrado (defensivo).
    if (s.cobrado === false) {
      lineas.push({
        regla: "eventual",
        codigo: "no_cobrado",
        monto: 0,
        base: s.utilidad,
        tasa: null,
        servicioId: s.id,
        clienteId: s.clienteId,
        vendedorId,
        fechaCobro: s.fechaCobro,
        detalle: `Eventual #${s.id}: no cobrado, no comisiona ni cuenta para el tramo/fondo.`,
      });
      continue;
    }

    const ctx = clientes[s.clienteId];
    const paramCobro = parametrosVigentes(parametros, s.fechaCobro);
    const ventanaMeses = paramCobro?.ventanaMeses ?? 12;

    // 2. Cliente nuevo. Sin contexto se asume nuevo (el caller solo quería el tramo).
    if (ctx) {
      const paramCot = parametrosVigentes(parametros, ctx.fechaCotizacion);
      const v = esClienteNuevo(ctx, paramCot?.ventanaMeses ?? ventanaMeses);
      if (!v.nuevo) {
        lineas.push({
          regla: "eventual",
          codigo: v.motivo === "en_lista" ? "cliente_existente" : "cliente_sin_ventana",
          monto: 0,
          base: s.utilidad,
          tasa: null,
          servicioId: s.id,
          clienteId: s.clienteId,
          vendedorId,
          fechaCobro: s.fechaCobro,
          detalle:
            v.motivo === "en_lista"
              ? `Eventual #${s.id}: cliente en lista firmada, no es nuevo — S/0, no cuenta para tramo ni fondo.`
              : `Eventual #${s.id}: el cliente tuvo servicio en los últimos ${ventanaMeses} meses, no es nuevo — S/0.`,
        });
        continue;
      }
    }

    // 3. Dentro de la ventana de salida.
    const ancla = anclaDeCliente(s.clienteId, ctx, eventuales, contratosFijos);
    if (ancla && !dentroDeVentana(s.fechaServicio, ancla, ventanaMeses)) {
      lineas.push({
        regla: "eventual",
        codigo: "fuera_de_ventana",
        monto: 0,
        base: s.utilidad,
        tasa: null,
        servicioId: s.id,
        clienteId: s.clienteId,
        vendedorId,
        fechaCobro: s.fechaCobro,
        detalle: `Eventual #${s.id}: fuera de la ventana de ${ventanaMeses} meses (servicio ${s.fechaServicio}).`,
      });
      continue;
    }

    // Elegible: comisiona y aporta al fondo.
    elegibles.push(s);
    if (paramCobro) {
      aportesFondo.push({
        servicioId: s.id,
        montoPorEventual: paramCobro.montoFondoPorEventual,
        fechaCobro: s.fechaCobro,
        parametroDesde: paramCobro.vigente_desde,
      });
    }
  }

  // Tramo y comisión de los eventuales elegibles.
  lineas.push(...comisionarEventuales(elegibles, parametros, vendedorId));

  // Fondo administrativo (lo paga la empresa).
  const fondo = comisionarFondo(aportesFondo, operadoresCorroborados);
  lineas.push(...fondo.lineas);

  // ── Fijos ──
  for (const c of contratosFijos) {
    const ctx = clientes[c.clienteId];
    const ancla = anclaDeCliente(c.clienteId, ctx, eventuales, contratosFijos);
    lineas.push(...comisionarFijo(c, parametros, vendedorId, ancla));
  }

  // ── Bono de atención ──
  if (bonoAtencion) {
    const param = parametrosVigentes(parametros, bonoAtencion.fecha);
    const tope = param?.topeBonoAtencion ?? 150;
    const tol = param?.toleranciaRapidez ?? 0.9;
    lineas.push(
      comisionarBonoAtencion(bonoAtencion.indicadores, tope, tol, vendedorId, param?.vigente_desde).linea,
    );
  }

  // ── Totales ──
  let comisiones = 0;
  let retenidas = 0;
  let fondoTotal = 0;
  for (const l of lineas) {
    if (l.regla === "fondo_admin") {
      if (l.monto) fondoTotal += l.monto;
      continue;
    }
    if (l.codigo === "pagar" && l.monto) comisiones += l.monto;
    if (l.codigo === "retenido_falta_costear" && l.tasa != null) retenidas += l.base * l.tasa;
  }

  return {
    lineas,
    totales: {
      comisiones: Math.round(comisiones * 100) / 100,
      retenidas: Math.round(retenidas * 100) / 100,
      fondo: Math.round(fondoTotal * 100) / 100,
    },
  };
}
