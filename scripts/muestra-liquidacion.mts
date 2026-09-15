// Genera una muestra del "Formato de Liquidación y Conformidad del Servicio" con datos
// ficticios, para revisar el diseño sin sesión ni datos reales. Uso: npx tsx <este archivo>
//
// Reproduce a propósito el periodo real 15-06 al 14-07 (26 servicios en dos móviles,
// S/ 790 y S/ 420) que AFA liquidó en Excel: así se puede comparar el documento nuevo
// contra el que el cliente ya firmó, y comprobar que los totales coinciden.
//
// De paso funciona como prueba de la agrupación: si `agruparServicios` deja de contar
// 26/26 o de partir los móviles, este script lo canta en consola.
import fs from "node:fs";
import path from "node:path";
import {
  agruparServicios, analizarServicios, totalesValorizacion, fechaFormato,
  type ReservaLiq, type CatalogoLiq,
} from "../lib/liquidacion-agrupacion";
import { buildLiquidacionHtml, type DocLiquidacion, type FilaAnexo, type LineaDoc } from "../lib/liquidacion-doc";

const RAIZ = "C:/Users/trans/afa-erp-transporte";
const DESDE = "2026-06-15";
const HASTA = "2026-07-14";
const IGV = 18;

// ── Datos ficticios: dos móviles cubriendo la misma ruta y turno ─────────────

/** Días del periodo excluyendo domingos (así salen los 26 servicios del Excel real). */
function diasHabiles(desde: string, hasta: string, cuantos: number): string[] {
  const out: string[] = [];
  const d = new Date(desde + "T12:00:00");
  const fin = new Date(hasta + "T12:00:00");
  while (d <= fin && out.length < cuantos) {
    if (d.getDay() !== 0) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const DIAS = diasHabiles(DESDE, HASTA, 26);
const CONDUCTORES_M1 = ["Michael Bracamonte", "Carlos Pacori"];
const CONDUCTORES_M2 = ["Isaías Cavero", "Román Quincho"];

let idSeq = 4600;
function reserva(p: Partial<ReservaLiq> & { fecha: string; precio: number; vehiculo: number }): ReservaLiq {
  idSeq += 1;
  return {
    id: idSeq,
    codigo: `AFA-2026-${String(idSeq).padStart(6, "0")}`,
    fecha_servicio: p.fecha,
    hora_servicio: "22:00",
    estado: p.estado ?? "finalizada",
    estado_admin: "por_liquidar",
    cliente_id: 1,
    cliente_sede_id: 1,
    ruta_nombre: "RUTA 1/ ENTRADA 22:00/ CHORRILLOS→CD CALLAO · TURNO NOCHE",
    direccion_servicio: "ida",
    origen: "Chorrillos",
    destino: "CD Callao",
    precio_cliente: p.precio,
    costo_proveedor: p.costo_proveedor ?? null,
    tipo_asignacion: "propio",
    vehiculo_id: p.vehiculo,
    conductor_id: p.conductor_id ?? 1,
    pasajeros_abordados: p.pasajeros_abordados ?? null,
    capacidad_contratada: p.capacidad_contratada ?? null,
    hora_real_inicio: p.hora_real_inicio ?? null,
    hora_real_fin: p.hora_real_fin ?? null,
    tipo_servicio_detalle: "transporte_personal",
  };
}

const VEHICULOS: Record<number, { placa: string; cap: number; desc: string }> = {
  1: { placa: "F1J-959", cap: 50, desc: "Bus 50 pax · full equipo" },
  2: { placa: "AXP-940", cap: 12, desc: "Minibús 12 pax" },
  3: { placa: "AYL-789", cap: 45, desc: "Bus 45 pax · full equipo" },
};

// Cada día genera IDA y RETORNO por móvil, enlazados con reserva_vinculada_id y con
// el importe COMPLETO en la ida (el retorno va en S/ 0.00) — la convención real de AFA:
// una sola tarifa cubre los dos tramos. Son 104 reservas que deben liquidarse como
// 52 servicios, no como 104.
const reservas: ReservaLiq[] = [];
function parDelDia(f: string, i: number, veh: number, precio: number, costo: number, pax: number, horas: { ida: [string, string]; ret: [string, string] }) {
  // Los asientos CONTRATADOS son del día y no cambian con la ocupación: se escriben
  // iguales en los dos tramos, como los escribe Programación.
  const contratados = veh === 2 ? 12 : 45;
  const ida = reserva({
    fecha: f, precio, vehiculo: veh, costo_proveedor: costo,
    conductor_id: veh, pasajeros_abordados: pax, capacidad_contratada: contratados,
    hora_real_inicio: horas.ida[0], hora_real_fin: horas.ida[1],
  });
  const ret = reserva({
    fecha: f, precio: 0, vehiculo: veh, costo_proveedor: 0,
    conductor_id: veh, pasajeros_abordados: pax - 1, capacidad_contratada: contratados,
    hora_real_inicio: horas.ret[0], hora_real_fin: horas.ret[1],
  });
  ida.reserva_vinculada_id = ret.id;
  ret.reserva_vinculada_id = ida.id;
  ret.direccion_servicio = "retorno";
  reservas.push(ida, ret);
}

DIAS.forEach((f, i) => {
  parDelDia(f, i, 1, 790, 560, 47 + (i % 4), {
    ida: ["21:5" + (7 + (i % 3)), "23:0" + (5 + (i % 5))],
    ret: ["05:58", "07:1" + (i % 5)],
  });
  // El móvil 2 se demora 35 minutos el 03/07 → penalidad y fila marcada en el Anexo 1.
  const tarde = f === "2026-07-03";
  parDelDia(f, i, 2, 420, 300, 9 + (i % 2), {
    ida: [tarde ? "22:35" : "21:5" + (8 + (i % 2)), tarde ? "23:29" : "22:4" + (7 + (i % 3))],
    ret: ["06:02", "07:0" + (i % 6)],
  });
});
// Servicio adicional autorizado por el cliente.
const adicional = reserva({
  fecha: "2026-06-28", precio: 790, vehiculo: 3, costo_proveedor: 560,
  conductor_id: 3, pasajeros_abordados: 44, hora_real_inicio: "22:04", hora_real_fin: "23:18",
});

const catalogo: CatalogoLiq = {
  placaDe: (r) => VEHICULOS[Number(r.vehiculo_id)]?.placa ?? "",
  capacidadDe: (r) => VEHICULOS[Number(r.vehiculo_id)]?.cap ?? null,
  conductorDe: (r) =>
    r.vehiculo_id === 1 ? CONDUCTORES_M1[r.id % 2] :
    r.vehiculo_id === 2 ? CONDUCTORES_M2[r.id % 2] : "Sergio Sánchez",
  sedeNombre: "CD CALLAO",
};

// ── Agrupación (esto es lo que se prueba) ───────────────────────────────────

const analisis = analizarServicios(reservas, "cliente");
const lineasAgrupadas = agruparServicios(analisis.pares, {
  lado: "cliente", catalogo, preciosIncluyenIgv: false, igvPct: IGV,
  sede: "CD CALLAO", desde: DESDE, hasta: HASTA,
});

const lineas: LineaDoc[] = lineasAgrupadas.map((l, i) => ({
  item: i + 1,
  tipo: "servicio",
  descripcion: l.descripcion,
  unidad_medida: l.unidad_medida,
  cantidad_programada: l.cantidad_programada,
  cantidad_ejecutada: l.cantidad_ejecutada,
  cantidad: l.cantidad,
  precio_unitario: l.precio_unitario,
  total_linea: l.total_linea,
  detalle: `Unidad ${l.placas.join(", ")} · ${l.cantidad} servicios · ver Anexo 1 (ítems ${l.referencia})`,
}));

// Ajustes del periodo: el adicional autorizado y la penalidad por la demora.
lineas.push({
  item: lineas.length + 1, tipo: "adicional",
  descripcion: "ADICIONAL — Servicio extra 28/06/2026, traslado turno noche por sobredemanda",
  unidad_medida: "SERV.", cantidad: 1, precio_unitario: 790, total_linea: 790,
  detalle: `Autorizado por M. Castro Portella · N° ${adicional.codigo}`,
});
lineas.push({
  item: lineas.length + 1, tipo: "penalidad",
  descripcion: "DESCUENTO — Penalidad por presentación tardía de unidad (35 min) el 03/07/2026",
  unidad_medida: "SERV.", cantidad: 1, precio_unitario: 210, total_linea: -210,
  detalle: "Cláusula 8.2 del contrato · evidencia en el Anexo 2",
});

const totales = totalesValorizacion(
  lineas.map((l) => ({ tipo: l.tipo, cantidad: l.cantidad, precio_unitario: l.precio_unitario })),
  IGV
);

// ── Anexo 1: una fila por servicio ejecutado ────────────────────────────────

// El anexo lista los DOS tramos del servicio con el mismo número de ítem: el retorno
// va como "Incluido" en S/ 0.00, igual que lo arma lib/liquidacion-datos.ts.
const SERIES = ["A", "B"];
// El anexo se imprime en orden de fecha sobre todo el periodo, no por línea:
// se arma con su clave cronológica y se ordena al final, igual que el loader real.
const pendientes: { fila: FilaAnexo; clave: string }[] = [];
let kmMuestra = 0;
lineasAgrupadas.forEach((l, gi) => {
  let n = 0;
  const vistos = new Set<number>();
  for (const rid of l.reservas) {
    const r = reservas.find((x) => x.id === rid)!;
    if (!vistos.has(r.id)) {
      n += 1;
      vistos.add(r.id);
      if (r.reserva_vinculada_id) vistos.add(r.reserva_vinculada_id);
    }
    const tarde = r.hora_real_inicio === "22:35";
    const incluida = !Number(r.precio_cliente);
    const ref = `${SERIES[gi] ?? "X"}-${String(n).padStart(2, "0")}`;
    kmMuestra += l.movil === 1 ? 42.1 + (n % 5) / 10 : 28.2 + (n % 4) / 10;
    pendientes.push({
      // El par ida↔retorno viaja junto: se ubica en la fecha de la ida.
      clave: `${String(r.fecha_servicio).slice(0, 10)}|${ref}|${String(r.hora_servicio ?? "")}`,
      fila: {
        ref,
        fecha: fechaFormato(r.fecha_servicio).slice(0, 5),
        codigo: r.codigo!,
        ruta: `CD Callao → ${l.ruta} (${r.direccion_servicio === "retorno" ? "Retorno" : "Ida"})`,
        // El Anexo 1 lleva la HORA del servicio, no un turno deducido.
        turno: String(r.hora_servicio ?? "").slice(0, 5) || "—",
        placa: catalogo.placaDe(r),
        conductor: catalogo.conductorDe(r),
        // La columna PAX del anexo es la capacidad CONTRATADA, no la ocupación.
        paxContratado: r.capacidad_contratada ?? null,
        estado: tarde ? "Tardío" : incluida ? "Incluido" : "Conforme",
        importe: incluida ? 0 : l.precio_unitario,
        alerta: tarde,
      },
    });
  }
});
kmMuestra += 42.8;
pendientes.push({
  clave: "2026-06-28|C-01|22:00",
  fila: {
    ref: "C-01", fecha: "28/06", codigo: adicional.codigo!,
    ruta: "CD Callao → RUTA 1 (Ida) · adicional", turno: "22:00",
    placa: "AYL-789", conductor: "Sergio Sánchez", paxContratado: 44,
    estado: "Adicional", importe: 790,
  },
});
const anexo1: FilaAnexo[] = pendientes
  .sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0))
  .map((p) => p.fila);

// ── Documento ───────────────────────────────────────────────────────────────

const QRCode = (await import("qrcode")).default;
const url = "https://afatoursperu.com/conformidad/7f2a9c31b845c0de";
const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 });

const empresa = {
  nombre: "AFA Tours Peru S.A.C.",
  ruc: "20601234567",
  email: "administracion@afatoursperu.com",
  telefono: "(01) 3453707 – 966 707 225",
  web: "www.afatoursperu.com",
  direccion: "Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana · Lima",
  logo: `file:///${RAIZ}/public/logoafacotizacion-removebg-preview.png`,
};

const docCliente: DocLiquidacion = {
  lado: "cliente",
  control: {
    codigo: "AFA-FL-07", titulo: "Formato de Liquidación y Conformidad del Servicio",
    macro_proceso: "Gestión Logística", proceso: "Venta de bienes y servicios",
    subproceso: "No aplica", version: "03", vigencia_desde: "01/01/2025",
  },
  codigo: "LQC-2026-000318",
  estadoLabel: "CONFORMADA",
  emitido: "18/07/2026 14:22",
  contraparte: {
    nombre: "SNACKS AMERICA LATINA S.R.L.", ruc: "20297182456",
    area: "PEPSICO CD CALLAO", usuario: "MIGUEL CASTRO PORTELLA",
    cargo: "SUPERVISOR DE RECURSOS HUMANOS",
  },
  servicio: {
    contratado: "SERVICIO DE TRANSPORTE DE PERSONAL / TURNO NOCHE",
    ubicacion: "PEPSICO CD CALLAO",
    periodo: `${fechaFormato(DESDE)} AL ${fechaFormato(HASTA)}`,
    inicio: "15/06/2026", fin: "14/07/2026",
    fechaValorizacion: "18/07/2026", moneda: "PEN", ordenCompra: "OC 4500218837",
  },
  lineas,
  totales: { ...totales, igvPct: IGV },
  documentacion: [
    { nombre: "Formato de Liquidación y Conformidad del Servicio (este documento)", estado: "SÍ", copias: 1 },
    { nombre: `Anexo 1 — Detalle de los ${anexo1.length} servicios ejecutados`, estado: "SÍ", copias: 1 },
    { nombre: "Anexo 2 — Evidencia operativa (GPS, puntualidad, pasajeros)", estado: "SÍ", copias: 1 },
    { nombre: "Manifiestos de pasajeros MTC del periodo", estado: `${anexo1.length} pág.`, copias: 1 },
    { nombre: "Factura electrónica", estado: "AL APROBAR", copias: 1 },
  ],
  conformidad: {
    estado: "conforme", grado: "CONFORME",
    por: "MIGUEL CASTRO PORTELLA", cargo: "Supervisor de RR.HH.",
    fecha: "21/07/2026 09:14", ip: "190.234.xx.xx", canal: "correo",
    sello: "7F2A-9C31-B845",
  },
  comentarios:
    "Se cumplió el 100% de los servicios programados del periodo. Se atendió un servicio adicional el 28/06 por sobredemanda del turno noche. Se aplicó la penalidad acordada por la demora del 03/07.",
  anexo1,
  anexo2: {
    serviciosEjecutados: anexo1.length,
    serviciosProgramados: reservas.length,
    puntualidadPct: 96.2,
    // El Anexo 2 sí cuenta personas transportadas, y sale de las reservas: el Anexo 1
    // ya no lleva ese dato porque su columna PAX es la capacidad contratada.
    pasajeros: reservas.reduce((a, r) => a + (r.pasajeros_abordados ?? 0), 0),
    km: Math.round(kmMuestra),
    incidencias: [
      { fecha: "28/06", codigo: adicional.codigo!, tipo: "Adicional", descripcion: "Sobredemanda del turno noche: se despachó una unidad extra (AYL-789) a solicitud del área.", accion: "Autorizado por correo del cliente", efecto: 790 },
      { fecha: "03/07", codigo: "AFA-2026-004823", tipo: "Demora", descripcion: "Unidad AXP-940 se presentó 35 min tarde en el punto de embarque (congestión Av. Argentina).", accion: "Penalidad cláusula 8.2", efecto: -210 },
    ],
    unidades: [
      { placa: "F1J-959", descripcion: "Bus 50 pax · full equipo", soat: "12/2026", revision: "09/2026", mtc: "Vigente", gps: "100%", conductores: "2 habilitados" },
      { placa: "AXP-940", descripcion: "Minibús 12 pax", soat: "03/2027", revision: "08/2026", mtc: "Vigente", gps: "98%", conductores: "3 habilitados" },
      { placa: "AYL-789", descripcion: "Bus 45 pax · full equipo", soat: "11/2026", revision: "12/2026", mtc: "Vigente", gps: "100%", conductores: "2 habilitados" },
    ],
  },
  firmas: [
    { rol: "Gerente General", entidad: "AFA TOURS PERU S.A.C." },
    { rol: "Usuario", entidad: "SNACKS AMERICA LATINA S.R.L." },
    { rol: "Área solicitante", entidad: "PEPSICO CD CALLAO" },
  ],
  empresa,
  qr,
  urlVerificacion: url,
};

// ── Proveedor: mismo periodo, visto desde el lado del tercero ───────────────

const lineasProv: LineaDoc[] = [
  { item: 1, tipo: "servicio", descripcion: "TRANSPORTE DE PERSONAL CD CALLAO / RUTA 1 / TURNO NOCHE / UNIDAD F1J-959 (50 pax)", unidad_medida: "SERV.", cantidad_programada: 26, cantidad_ejecutada: 26, cantidad: 26, precio_unitario: 560, total_linea: 14560, detalle: "Conductor asignado: Michael Bracamonte · ver Anexo 1" },
  { item: 2, tipo: "servicio", descripcion: "TRANSPORTE DE PERSONAL CD CALLAO / RUTA 1 / TURNO NOCHE / UNIDAD AXP-940 (12 pax)", unidad_medida: "SERV.", cantidad_programada: 26, cantidad_ejecutada: 25, cantidad: 25, precio_unitario: 300, total_linea: 7500, detalle: "Conductor asignado: Isaías Cavero · ver Anexo 1" },
  { item: 3, tipo: "penalidad", descripcion: "PENALIDAD — Unidad no presentada el 09/07/2026 (cubierta con flota propia)", unidad_medida: "SERV.", cantidad: 1, precio_unitario: 350, total_linea: -350, detalle: "Contrato de tercerización, cláusula 6.4" },
];
const totProv = totalesValorizacion(
  lineasProv.map((l) => ({ tipo: l.tipo, cantidad: l.cantidad, precio_unitario: l.precio_unitario })),
  IGV
);
const totalComprobante = totProv.total;
const detraccion = Math.round(totalComprobante * 0.04 * 100) / 100;
const anticipos = 3000;

const docProveedor: DocLiquidacion = {
  ...docCliente,
  lado: "proveedor",
  control: {
    codigo: "AFA-FL-08", titulo: "Formato de Liquidación y Conformidad del Servicio — Proveedor",
    macro_proceso: "Gestión Logística", proceso: "Compra de bienes y servicios",
    subproceso: "Tercerización de transporte", version: "01", vigencia_desde: "01/01/2025",
  },
  codigo: "LQP-2026-000045",
  estadoLabel: "POR PAGAR",
  emitido: "18/07/2026 14:31",
  contraparte: {
    nombre: "TRANSPORTES & SERVICIOS GENERALES GUARCAL E.I.R.L.", ruc: "20605517741",
    area: "JEFE DE OPERACIONES — AFA TOURS", usuario: "AFA TOURS PERU S.A.C.",
    cargo: "JEFE DE OPERACIONES", cuentaDetraccion: "Banco de la Nación 00-123-456789",
  },
  servicio: {
    ...docCliente.servicio,
    contratado: "TRANSPORTE DE PERSONAL TERCERIZADO — CD CALLAO / TURNO NOCHE",
    ordenCompra: "OC-2026-00214",
  },
  lineas: lineasProv,
  totales: {
    ...totProv, igvPct: IGV,
    totalComprobante,
    detraccionPct: 4, detraccionMonto: detraccion, anticipos,
    total: Math.round((totalComprobante - detraccion - anticipos) * 100) / 100,
  },
  documentacion: [
    { nombre: "Factura del proveedor por el importe conformado", estado: "PENDIENTE", copias: "—" },
    { nombre: "Constancia de depósito de detracción", estado: "PENDIENTE", copias: "4%" },
    { nombre: "SOAT y revisión técnica vigentes de las unidades", estado: "CONFORME", copias: "OK" },
    { nombre: "Licencias y habilitación de conductores", estado: "CONFORME", copias: "OK" },
    { nombre: "Autorización MTC de la empresa", estado: "CONFORME", copias: "OK" },
  ],
  conformidad: {
    estado: "observada", grado: "CONFORME CON OBSERVACIONES",
    por: "AFA TOURS — Jefatura de Operaciones", cargo: "Jefe de Operaciones",
    fecha: "18/07/2026 14:31", canal: "portal", sello: "B3D1-4E77-A902",
    comentario: "Una unidad no se presentó el 09/07 y el servicio se cubrió con flota propia; se aplica la penalidad pactada.",
  },
  comentarios: "El resto del periodo se ejecutó sin incidencias. Se recomienda mantener al proveedor en el siguiente periodo.",
  anexo1: [],
  anexo2: null,
  firmas: [
    { rol: "Proveedor", entidad: "GUARCAL E.I.R.L." },
    { rol: "Jefe de Operaciones", entidad: "AFA TOURS PERU S.A.C." },
    { rol: "Administración", entidad: "AFA TOURS PERU S.A.C." },
  ],
};

// ── Salida + verificación en consola ────────────────────────────────────────

const dir = process.env.TEMP || ".";
const fCli = path.join(dir, "liquidacion-cliente-muestra.html");
const fProv = path.join(dir, "liquidacion-proveedor-muestra.html");
fs.writeFileSync(fCli, buildLiquidacionHtml(docCliente), "utf8");
fs.writeFileSync(fProv, buildLiquidacionHtml(docProveedor), "utf8");

console.log("── Emparejamiento ida + retorno ─────────────");
console.log(`  reservas del periodo      : ${reservas.length}`);
console.log(`  servicios facturables     : ${analisis.pares.length}  (una tarifa cubre los dos tramos)`);
console.log(`  bloqueadas                : ${analisis.bloqueadas.length}`);
console.log(`  avisos                    : ${analisis.avisos.length}`);
console.log("── Agrupación ───────────────────────────────");
for (const l of lineasAgrupadas)
  console.log(`  ${l.moviles > 1 ? `móvil ${l.movil}/${l.moviles} · ` : ""}${l.nombre_ida ?? l.ruta}${l.nombre_retorno ? ` ↩ ${l.nombre_retorno}` : ""} · ${l.pax_contratado ?? "sin pax"} · ${l.placas.join("/")} → ${l.cantidad_ejecutada}/${l.cantidad_programada} × S/ ${l.precio_unitario} = S/ ${l.total_linea}  (${l.reservas.length} tramos)`);
console.log("── Totales cliente ──────────────────────────");
console.log(`  servicios   S/ ${totales.servicios}`);
console.log(`  adicionales S/ ${totales.adicionales}`);
console.log(`  descuentos  S/ ${totales.descuentos}`);
console.log(`  subtotal    S/ ${totales.subtotal}`);
console.log(`  IGV ${IGV}%     S/ ${totales.igv}`);
console.log(`  TOTAL       S/ ${totales.total}`);
console.log("  (el Excel real, sin ajustes, cerró en S/ 37,122.80)");
console.log("── HTML ─────────────────────────────────────");
console.log("  cliente:  ", fCli);
console.log("  proveedor:", fProv);
