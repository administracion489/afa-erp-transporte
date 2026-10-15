import { motivoDespacho, pendientesDeCotizar, prellenadoCotizacion, puedeVincular, validarMotivoNoRequiere, type ReservaDespacho } from "../lib/despacho-sin-cotizar";
let fallos = 0, ok = 0;
const t = (c: boolean, m: string) => { if (c) ok++; else { fallos++; console.log("FALLA:", m); } };
// Conteo VIEJO copiado literal (filtro de la consulta de app/cotizaciones/page.tsx)
const viejo = (rows: ReservaDespacho[]) => rows.filter((r) => r.origen_despacho === true && r.cotizacion_id == null).length;

const filas: ReservaDespacho[] = []; let id = 1;
for (const estado of ["confirmada", "cancelada", "finalizada", "en_curso", null])
  for (const cot of [null, 7]) for (const mot of [null, "", "   ", "Cortesía al cliente"]) for (const od of [true, false, null])
    filas.push({ id: id++, estado, cotizacion_id: cot, cotizacion_no_requerida_motivo: mot, origen_despacho: od });
const pend = pendientesDeCotizar(filas);
for (const r of filas) {
  const m = motivoDespacho(r);
  t(pend.includes(r) === (m === "requiere_cotizacion"), `invariante ${r.id}`);
  if (r.estado === "cancelada" || r.cotizacion_id != null) t(!pend.includes(r), `cuenta cancelado/vinculado ${r.id}`);
}
t(pend.length > 0, "corolario: hay pendientes");
t(viejo(filas) > pend.length, "viejo cuenta de más");
t(viejo(filas.filter((r) => r.estado === "cancelada")) > 0, "viejo reproduce el bug: cuenta cancelados");

// Prellenado
for (const p of [100, 118, 236.5, 1, 999.99, 4321.87]) {
  const pr = prellenadoCotizacion({ id: 1, precio_cliente: p, origen_despacho: true }, "2026-10-15");
  const u = pr.items[0].precio_unit!;
  t(Math.abs(Math.round(u * 1.18 * 100) / 100 - p) <= 0.0101, `IGV ${p} -> ${u}`);
}
const vacio = prellenadoCotizacion({ id: 2, origen_despacho: true }, "2026-10-15");
t(vacio.cliente_id === null && vacio.origen === "" && vacio.destino === "" && vacio.fecha_servicio === "" && vacio.hora_ida === "" && vacio.asunto === "" && vacio.items[0].precio_unit === null, "sin campos inventados");
const lleno = prellenadoCotizacion({ id: 3, cliente_id: 5, origen: "Lima", destino: "Ica", fecha_servicio: "2026-10-01", hora_servicio: "06:30:00", reserva_vinculada_id: 9, origen_despacho: true }, "2026-10-15");
t(lleno.hora_ida === "06:30" && lleno.asunto === "Lima → Ica" && lleno.tipo_servicio === "ida_retorno" && lleno.modo_servicio === "eventual", "lleno");
t(prellenadoCotizacion({ id: 4, ruta_nombre: "RUTA A", origen: "x", destino: "y" }, "").asunto === "RUTA A", "asunto ruta");
t(prellenadoCotizacion({ id: 4 }, "").tipo_servicio === "solo_ida", "solo ida");

// puedeVincular
const r: ReservaDespacho = { id: 1, cliente_id: 5, cotizacion_id: null };
t(puedeVincular(r, { id: 1, cliente_id: 5, modo_servicio: "eventual", estado: "aprobada" }).ok, "vincula");
t(!puedeVincular(r, { id: 1, cliente_id: 6 }).ok, "cliente distinto");
t(!puedeVincular(r, { id: 1, cliente_id: 5, modo_servicio: "fijo" }).ok, "fijo");
t(!puedeVincular(r, { id: 1, cliente_id: 5, estado: "rechazada" }).ok, "rechazada");
t(!puedeVincular({ id: 1, cliente_id: null }, { id: 1, cliente_id: null }).ok, "sin cliente");
t(!validarMotivoNoRequiere("  ab  ").ok && validarMotivoNoRequiere(" cortesía ").ok, "motivo");
console.log(`${ok} ok, ${fallos} fallos`); if (fallos) process.exit(1);
