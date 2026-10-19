// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/servicio.ts — El cotizador automático de traslados, de punta a punta, SIN enviar
// nada: ubica los dos lugares, carga el catálogo y le pregunta al motor. SOLO SERVIDOR.
//
// Lo llaman el simulador de /tarifario y, en la fase siguiente, la herramienta del agente IA del
// CRM. Son la misma función a propósito: lo que el dueño prueba en el simulador es exactamente
// lo que la IA va a cotizar.
// ──────────────────────────────────────────────────────────────────────────────

import type { EntradaSimulador, LugarUbicado, RespuestaSimulador } from "./api";
import { cargarCatalogo, leerIgvPct, leerTipoCambioUsd, SinMigracionTraslados } from "./datos";
import { evaluarTraslado, type PuntoUbicado } from "./motor";
import { ubicarLugar } from "./ubicar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** El punto que se le pasa al motor. Una dirección que Google no encontró es un punto SIN ubicación (el motor la vuelve a pedir). */
function puntoParaMotor(l: LugarUbicado, texto: string): PuntoUbicado | null {
  if (l.codigo === "vacio") return null;
  if (l.codigo === "no_encontrado") return { texto, lat: null, lng: null, localidades: [], barrios: [] };
  return l.punto;
}

const textoDe = (x: EntradaSimulador["origen"]) => (typeof x === "string" ? x : x.texto ?? `${x.lat}, ${x.lng}`);

export async function simularTraslado(sb: Sb, entrada: EntradaSimulador, hoy: string): Promise<RespuestaSimulador> {
  let catalogo;
  try {
    catalogo = await cargarCatalogo(sb);
  } catch (e) {
    if (e instanceof SinMigracionTraslados) return { ok: false, codigo: "sin_migracion", detalle: e.message };
    return { ok: false, codigo: "error", detalle: (e as Error).message };
  }
  const [origen, destino, tipoCambio, igvPct] = await Promise.all([
    ubicarLugar(entrada.origen), ubicarLugar(entrada.destino), leerTipoCambioUsd(sb, hoy), leerIgvPct(sb),
  ]);
  // Un fallo de Google (cuota, clave, red) no es culpa de la dirección: no se le pregunta al cliente.
  for (const [l, nombre] of [[origen, "el recojo"], [destino, "el destino"]] as const) {
    if (l.codigo === "error" || l.codigo === "sin_clave") {
      return { ok: false, codigo: "error", detalle: `No se pudo ubicar ${nombre}: ${l.detalle}` };
    }
  }
  const resultado = evaluarTraslado({
    origen: puntoParaMotor(origen, textoDe(entrada.origen)),
    destino: puntoParaMotor(destino, textoDe(entrada.destino)),
    fecha_servicio: entrada.fecha_servicio, hora_servicio: entrada.hora_servicio,
    sentido: entrada.sentido, fecha_retorno: entrada.fecha_retorno, hora_retorno: entrada.hora_retorno,
    pax: entrada.pax, maletas: entrada.maletas, telefono: entrada.telefono,
    paradas_intermedias: entrada.paradas_intermedias, fechas_adicionales: entrada.fechas_adicionales,
    vehiculos_pedidos: entrada.vehiculos_pedidos, senales: entrada.senales,
  }, {
    zonas: catalogo.zonas, categorias: catalogo.categorias, tarifas: catalogo.tarifas,
    tipoCambio, hoy, igvPct, validezDias: catalogo.config.validez_dias,
  });
  return { ok: true, resultado, lugares: { origen, destino } };
}
