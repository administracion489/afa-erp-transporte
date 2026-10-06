// lib/radar/remitente-unidades.ts — QUIÉN mandó la foto y QUÉ unidad manejaba ese día.
//
// El lado que lee de `lib/radar/procedencia-placa.ts` (que es puro). Lo usan el Radar al
// procesar una foto de tablero (lib/radar/acciones.ts) y la auditoría de lo ya grabado
// (/radar-ia → Odómetro): una sola definición de «la unidad de este remitente ese día», o el
// Radar y la pantalla terminan contestando distinto sobre la misma foto.
//
// Recibe el cliente de Supabase inyectado: el servidor usa el service-role y la pantalla el del
// navegador (RLS de usuario autenticado). Nada aquí lanza: ante un fallo de lectura el remitente
// queda en `no_se_pudo_leer`, que NUNCA graba solo — una lista vacía por error se leería como
// «no tenía servicio» y llevaría a una conclusión falsa.

import { telefonoDeRemitente, telefonosDeFicha, tel9 } from "./cluster-remitente";
import type { Remitente, UnidadRef } from "./procedencia-placa";

export type UnidadFlota = UnidadRef & { kilometraje_actual: number | null };

/** Las dos flotas, con su placa. `null` si alguna no se pudo leer (no se puede afirmar qué está escrito). */
export async function cargarFlotaUnidades(sb: any): Promise<UnidadFlota[] | null> {
  try {
    const [p, t] = await Promise.all([
      sb.from("vehiculos").select("id, placa, kilometraje_actual"),
      sb.from("vehiculos_tercero").select("id, placa, kilometraje_actual"),
    ]);
    if (p.error || t.error) return null;
    const fila = (flota: "propia" | "tercero") => (v: any): UnidadFlota => ({
      flota,
      id: Number(v.id),
      placa: String(v.placa ?? ""),
      kilometraje_actual: v.kilometraje_actual != null ? Number(v.kilometraje_actual) : null,
    });
    return [
      ...((p.data as any[]) ?? []).map(fila("propia")),
      ...((t.data as any[]) ?? []).map(fila("tercero")),
    ].filter((u) => u.placa.trim());
  } catch {
    return null;
  }
}

/** La clave con que `remitentesPorDia` devuelve cada consulta. */
export const claveRemitenteDia = (wa: string | null | undefined, fecha: string) => `${wa ?? ""}|${fecha}`;

type Ficha = { propios: number[]; terceros: number[]; nombres: string[] };

/**
 * Para cada (remitente, fecha): si su número es de un conductor —propio o de tercero— y qué
 * unidades tenía en servicio ese día (reservas no canceladas, de las dos flotas).
 */
export async function remitentesPorDia(
  sb: any,
  consultas: { wa: string | null | undefined; fecha: string }[],
  flota: UnidadFlota[],
): Promise<Map<string, Remitente>> {
  const out = new Map<string, Remitente>();
  const conTel: { clave: string; tel: string; digitos: string; fecha: string }[] = [];
  for (const c of consultas) {
    const clave = claveRemitenteDia(c.wa, c.fecha);
    const digitos = telefonoDeRemitente(c.wa);
    if (!digitos) out.set(clave, { codigo: "sin_telefono" });
    else conTel.push({ clave, tel: tel9(digitos), digitos, fecha: c.fecha });
  }
  if (!conTel.length) return out;
  const fallo = () => { for (const c of conTel) out.set(c.clave, { codigo: "no_se_pudo_leer" }); return out; };

  // 1) Los números de las fichas: conductores propios Y de terceros. Antes solo se miraba
  //    `conductores`, así que el chofer de una tercerizada nunca era «un conductor registrado».
  const fichas = new Map<string, Ficha>();
  try {
    const [p, t] = await Promise.all([
      sb.from("conductores").select("id, nombre, telefono").not("telefono", "is", null),
      sb.from("conductores_tercero").select("id, nombre, telefono").not("telefono", "is", null),
    ]);
    if (p.error || t.error) return fallo();
    const indexar = (filas: any[], tipo: "propios" | "terceros") => {
      for (const f of filas ?? []) {
        for (const tel of telefonosDeFicha(f.telefono)) {
          const ficha = fichas.get(tel) ?? { propios: [], terceros: [], nombres: [] };
          ficha[tipo].push(Number(f.id));
          if (f.nombre && !ficha.nombres.includes(String(f.nombre))) ficha.nombres.push(String(f.nombre));
          fichas.set(tel, ficha);
        }
      }
    };
    indexar(p.data as any[], "propios");
    indexar(t.data as any[], "terceros");
  } catch {
    return fallo();
  }

  const identificados = conTel.filter((c) => fichas.has(c.tel));
  for (const c of conTel) if (!fichas.has(c.tel)) out.set(c.clave, { codigo: "no_registrado", telefono: c.digitos });
  if (!identificados.length) return out;

  // 2) Sus servicios de esos días.
  const propios = [...new Set(identificados.flatMap((c) => fichas.get(c.tel)!.propios))];
  const terceros = [...new Set(identificados.flatMap((c) => fichas.get(c.tel)!.terceros))];
  const fechas = [...new Set(identificados.map((c) => c.fecha))].sort();
  const filtroConductor = [
    propios.length ? `conductor_id.in.(${propios.join(",")})` : null,
    terceros.length ? `conductor_tercero_id.in.(${terceros.join(",")})` : null,
  ].filter(Boolean).join(",");
  const reservas: any[] = [];
  try {
    for (let i = 0; i < fechas.length; i += 60) {
      const tramo = fechas.slice(i, i + 60);
      for (let desde = 0; desde < 50_000; desde += 1000) {
        const { data, error } = await sb.from("reservas")
          .select("id, fecha_servicio, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id")
          .in("fecha_servicio", tramo)
          .or(filtroConductor)
          .neq("estado", "cancelada")
          .order("id", { ascending: true })
          .range(desde, desde + 999);
        if (error) {
          for (const c of identificados) out.set(c.clave, { codigo: "no_se_pudo_leer" });
          return out;
        }
        reservas.push(...((data as any[]) ?? []));
        if (!data || data.length < 1000) break;
      }
    }
  } catch {
    for (const c of identificados) out.set(c.clave, { codigo: "no_se_pudo_leer" });
    return out;
  }

  const placaDe = (f: "propia" | "tercero", id: number) =>
    flota.find((u) => u.flota === f && u.id === id)?.placa ?? `#${id}`;
  for (const c of identificados) {
    const ficha = fichas.get(c.tel)!;
    const asignadas: UnidadRef[] = [];
    const sumar = (f: "propia" | "tercero", id: unknown) => {
      const n = Number(id);
      if (!Number.isFinite(n) || n <= 0) return;
      if (asignadas.some((u) => u.flota === f && u.id === n)) return;
      asignadas.push({ flota: f, id: n, placa: placaDe(f, n) });
    };
    for (const r of reservas) {
      if (String(r.fecha_servicio).slice(0, 10) !== c.fecha) continue;
      const suya = (r.conductor_id != null && ficha.propios.includes(Number(r.conductor_id)))
        || (r.conductor_tercero_id != null && ficha.terceros.includes(Number(r.conductor_tercero_id)));
      if (!suya) continue;
      sumar("propia", r.vehiculo_id);
      sumar("tercero", r.vehiculo_tercero_id);
    }
    out.set(c.clave, { codigo: "identificado", telefono: c.digitos, conductores: ficha.nombres, asignadas });
  }
  return out;
}
