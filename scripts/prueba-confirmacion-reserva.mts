// Matriz de la Confirmación de Reserva (lib/confirmacion-reserva.ts + su PDF).
//   npx tsx scripts/prueba-confirmacion-reserva.mts            (MUESTRA_DIR=<carpeta> deja los PDF)
import { writeFileSync } from "node:fs";
import { cambiosEntre, canonico, docConfirmacion, importeDelDia, juzgarConfirmacion, mensajeWhatsApp, planVersion,
  telefonoWa, horaTexto, fechaLarga, type EntradaConfirmacion, type TramoConf, type DatosConfirmacion } from "../lib/confirmacion-reserva";
import { dibujarConfirmacion } from "../lib/confirmacion-reserva-pdf";
import { PDFDocument } from "pdf-lib";

let ok = 0, fallos = 0;
const t = (c: boolean, m: string) => { if (c) ok++; else { fallos++; console.log("FALLA:", m); } };
const codigos = (j: { bloqueos: { codigo: string }[] }) => j.bloqueos.map((b) => b.codigo);
const avisos = (j: { avisos: { codigo: string }[] }) => j.avisos.map((b) => b.codigo);

const tramo = (o: Partial<TramoConf> = {}): TramoConf => ({
  id: 100, codigo: "OS-2026-009293", fecha_servicio: "2026-10-24", hora_servicio: "06:30:00", estado: "programada",
  origen: "Aeropuerto Jorge Chávez", destino: "Hotel Belmond, Miraflores", ruta_nombre: null, direccion_servicio: "ida",
  precio_cliente: 236, capacidad_contratada: 4, tipo_servicio_detalle: "solo_ida", cliente_id: 7, cotizacion_id: 50,
  reserva_vinculada_id: null, ...o,
});
const base = (o: Partial<EntradaConfirmacion> = {}): EntradaConfirmacion => ({
  tramos: [tramo()],
  asignaciones: {},
  cliente: { id: 7, nombre: "Juan Pérez", empresa: null, telefono: "987654321", operativo_nombre: null, operativo_celular: null, condicion_pago: "Contado" },
  cotizacion: { id: 50, numero_cotizacion: "COT-2026-0451", atencion: "Sr. Pérez", moneda: "PEN", tipo_cambio: null, incluye_igv: true, tipo_servicio: "solo_ida", modo_servicio: "eventual", idioma_pdf: "es" },
  pagos: [{ id: 1, codigo: "RC-2026-000001", fecha: "2026-10-20", monto: 100, moneda: "PEN", metodo: "yape", anulado: false }],
  extras: null,
  ...o,
});

// 1. Adelanto validado, SIN conductor ni unidad asignados.
const j1 = juzgarConfirmacion(base());
t(j1.ok, "1 emite con adelanto y sin asignación");
t(avisos(j1).includes("sin_asignacion"), "1 avisa sin asignación");
t(j1.datos!.operacion.asignado === false && j1.datos!.operacion.unidades[0].vehiculo === null, "1 sin unidad en la foto");
const doc1 = docConfirmacion(j1.datos!, "es", { version: 1, emitidoEn: "2026-10-21" }, { nombre: "AFA", telefono: "01 555", email: "", web: "", direccion: "", ruc: "" });
t(doc1.secciones.some((s) => s.nota?.includes("serán enviados posteriormente")), "1 el papel dice que se enviarán después");

// 2. Unidad y conductor asignados (teléfono solo si se autoriza).
const asig = { 100: { vehiculo: { placa: "cwq-400", marca: "Toyota", modelo: "Hiace", categoria: "VAN" }, conductor: { nombre: "Luis Ramos", telefono: "999111222" } } };
const j2 = juzgarConfirmacion(base({ asignaciones: asig }));
t(j2.ok && j2.datos!.operacion.asignado, "2 asignado");
t(j2.datos!.operacion.unidades[0].vehiculo!.placa === "CWQ-400", "2 placa en mayúsculas");
t(j2.datos!.operacion.unidades[0].conductor!.telefono === null, "2 sin autorización no sale el teléfono");
const j2b = juzgarConfirmacion(base({ asignaciones: asig, extras: { incluir_telefono_conductor: true } }));
t(j2b.datos!.operacion.unidades[0].conductor!.telefono === "999111222", "2 con autorización sale el teléfono");
t(!JSON.stringify(j2b.datos).match(/dni|licencia|costo|margen/i), "2 la foto no lleva DNI, licencia, costos ni margen");

// 3. Saldo pendiente y pagado.
t(j1.datos!.economia.total === 236 && j1.datos!.economia.adelanto === 100 && j1.datos!.economia.saldo === 136 && j1.datos!.economia.estado === "adelanto", "3 saldo 136");
const j3 = juzgarConfirmacion(base({ pagos: [{ id: 1, fecha: "2026-10-20", monto: 236, moneda: "PEN" }] }));
t(j3.datos!.economia.saldo === 0 && j3.datos!.economia.estado === "pagado", "3 pagado");
const j3b = juzgarConfirmacion(base({ pagos: [{ id: 1, fecha: "2026-10-20", monto: 300, moneda: "PEN" }] }));
t(codigos(j3b).includes("adelanto_excede"), "3 adelanto mayor que el precio bloquea");
const j3c = juzgarConfirmacion(base({ pagos: [{ id: 1, fecha: "2026-10-20", monto: 100, moneda: "PEN", anulado: true }] }));
t(codigos(j3c).includes("sin_adelanto"), "3 un cobro anulado no cuenta");

// 4. Soles y dólares.
const usd = base({ cotizacion: { ...base().cotizacion!, moneda: "USD", tipo_cambio: 3.75 }, pagos: [{ id: 2, fecha: "2026-10-19", monto: 20, moneda: "USD" }] });
const j4 = juzgarConfirmacion(usd);
t(j4.ok && j4.datos!.economia.moneda === "USD" && Math.abs(j4.datos!.economia.total - 62.93) < 0.001, `4 USD al tc de la cotización (${j4.datos?.economia.total})`);
t(j4.datos!.economia.saldo === 42.93, "4 saldo en USD");
const j4b = juzgarConfirmacion({ ...usd, pagos: [{ id: 3, fecha: "2026-10-19", monto: 20, moneda: "PEN" }] });
t(codigos(j4b).includes("pago_otra_moneda"), "4 un cobro en soles sobre reserva en dólares bloquea");
const j4c = juzgarConfirmacion({ ...usd, cotizacion: { ...usd.cotizacion!, tipo_cambio: null } });
t(codigos(j4c).includes("moneda_sin_tc"), "4 dólares sin tipo de cambio bloquea");
t(importeDelDia([{ precio_cliente: 236 }], null).moneda === "PEN", "4 sin cotización = soles");

// 5. Ida y retorno: la tarifa va en uno; en los dos, bloquea.
const ida = tramo({ id: 100, reserva_vinculada_id: 101, tipo_servicio_detalle: "ida_retorno" });
const ret = tramo({ id: 101, codigo: "OS-2026-009294", direccion_servicio: "retorno", hora_servicio: "18:00", fecha_servicio: "2026-10-24", origen: "Hotel Belmond, Miraflores", destino: "Aeropuerto Jorge Chávez", precio_cliente: 0, reserva_vinculada_id: 100 });
const j5 = juzgarConfirmacion(base({ tramos: [ret, ida] }));
t(j5.ok && j5.datos!.servicio.tramos.length === 2 && j5.datos!.servicio.tramos[0].sentido === "ida", "5 dos tramos, ida primero");
t(j5.datos!.economia.total === 236 && j5.idDocumento === 100, "5 total del día y documento del menor id");
t(j5.datos!.reserva_codigo === "OS-2026-009293", "5 código de la ida");
const j5b = juzgarConfirmacion(base({ tramos: [ida, { ...ret, precio_cliente: 236 }] }));
t(codigos(j5b).includes("importe_duplicado"), "5 importe en los dos tramos bloquea");
const j5c = juzgarConfirmacion(base({ tramos: [ida, { ...ret, estado: "cancelada" }] }));
t(j5c.ok && j5c.datos!.servicio.tramos.length === 1 && avisos(j5c).includes("tramo_cancelado"), "5 un tramo cancelado sale del papel y avisa");
const j5d = juzgarConfirmacion(base({ tramos: [{ ...ida, precio_cliente: 0 }, ret], asignaciones: { 100: asig[100], 101: { vehiculo: { placa: "B8H-967" }, conductor: { nombre: "Ana Soto" } } } }));
t(codigos(j5d).includes("sin_importe"), "5 sin importe en ningún tramo bloquea (nunca un cero)");
const j5e = juzgarConfirmacion(base({ tramos: [ida, ret], asignaciones: { 100: asig[100], 101: { vehiculo: { placa: "B8H-967" }, conductor: { nombre: "Ana Soto" } } } }));
t(j5e.datos!.operacion.unidades.length === 2, "5 unidades distintas por tramo se listan aparte");
const j5f = juzgarConfirmacion(base({ tramos: [ida, ret], asignaciones: { 100: asig[100], 101: asig[100] } }));
t(j5f.datos!.operacion.unidades.length === 1 && j5f.datos!.operacion.unidades[0].sentidos.length === 2, "5 la misma unidad en ida y retorno sale una vez");

// 6. Traslado aeroportuario con vuelo.
const j6 = juzgarConfirmacion(base({ extras: { vuelo: "LA2045", punto_encuentro: "Llegadas nacionales, puerta 3" } }));
t(j6.datos!.servicio.vuelo === "LA2045" && j6.datos!.servicio.tipo === "traslado", "6 vuelo y tipo traslado");

// 7. Español e inglés: misma foto, distinto texto; no se traducen nombres ni placas.
const emp = { nombre: "AFA Transportes", telefono: "+51 966 707 225", email: "reservas@x.pe", web: "x.pe", direccion: "Av. X 123", ruc: "20123456789" };
const es = docConfirmacion(j2.datos!, "es", { version: 1, emitidoEn: "2026-10-21" }, emp);
const en = docConfirmacion(j2.datos!, "en", { version: 1, emitidoEn: "2026-10-21" }, emp);
t(es.titulo === "CONFIRMACIÓN DE RESERVA" && en.titulo === "BOOKING CONFIRMATION", "7 títulos");
const plano = (d: typeof es) => JSON.stringify(d);
t(plano(en).includes("CWQ-400") && plano(en).includes("Hotel Belmond, Miraflores") && plano(en).includes("OS-2026-009293"), "7 placa, dirección y código intactos en inglés");
t(horaTexto("18:05", "en") === "6:05 PM" && horaTexto("06:30:00", "es") === "06:30 h" && horaTexto("00:15", "en") === "12:15 AM", "7 horas");
t(fechaLarga("2026-10-24", "es") === "sábado 24 de octubre de 2026" && fechaLarga("2026-10-24", "en") === "Saturday, October 24, 2026", "7 fechas");
t(es.pie[0].includes("No reemplaza al comprobante") && en.pie[0].includes("does not replace"), "7 aviso de comprobante");
t(juzgarConfirmacion(base({ cotizacion: { ...base().cotizacion!, idioma_pdf: "en" } })).idiomaSugerido === "en", "7 idioma sugerido de la cotización");

// 8. Descarga / emisión repetida: misma firma → la MISMA versión.
const f2 = canonico(j2.datos);
const ultima = { id: 9, version: 1, firma: f2, datos: j2.datos! };
const p8 = planVersion(ultima, j2.datos!, f2);
t(p8.accion === "reusar" && p8.version === 1, "8 reintento reusa la versión");
t(canonico(JSON.parse(JSON.stringify(j2.datos))) === f2, "8 la firma sobrevive al viaje por jsonb");

// 9. Cambio posterior de horario, unidad o conductor → versión nueva con lo que cambió.
const cambiado = juzgarConfirmacion(base({ tramos: [tramo({ hora_servicio: "07:00" })], asignaciones: { 100: { ...asig[100], conductor: { nombre: "Otro Conductor" } } } }));
const p9 = planVersion(ultima, cambiado.datos!, canonico(cambiado.datos));
t(p9.accion === "nueva" && p9.version === 2, "9 nueva versión");
t(p9.accion === "nueva" && p9.cambios.includes("horario") && p9.cambios.includes("conductor") && !p9.cambios.includes("vehiculo"), "9 dice qué cambió");
t(cambiosEntre(j2.datos!, j2.datos!).length === 0, "9 sin cambios = vacío");
t(planVersion(null, j2.datos!, f2).accion === "nueva" && planVersion(null, j2.datos!, f2).version === 1, "9 primera versión");

// 10. Pago no validado o información incompleta.
const j10 = juzgarConfirmacion(base({ pagos: [] }));
t(codigos(j10).includes("sin_adelanto") && !j10.ok && j10.datos === null, "10 sin cobro registrado no emite");
const j10b = juzgarConfirmacion(base({ pagos: [], cliente: { ...base().cliente!, condicion_pago: "Crédito 30 días" } }));
t(j10b.ok && avisos(j10b).includes("credito") && j10b.datos!.economia.estado === "credito", "10 cliente a crédito emite y lo dice");
const j10c = juzgarConfirmacion(base({ tramos: [tramo({ hora_servicio: null, origen: " ", fecha_servicio: "2026-02-30" })], cliente: null }));
t(["sin_hora", "sin_origen", "sin_fecha", "sin_cliente"].every((c) => codigos(j10c).includes(c)), "10 datos obligatorios");
t(codigos(juzgarConfirmacion(base({ tramos: [tramo({ estado: "cancelada" })] }))).includes("cancelada"), "10 cancelada");
t(codigos(juzgarConfirmacion(base({ tramos: [tramo({ estado: "finalizada" })] }))).includes("ya_prestado"), "10 finalizada");
t(juzgarConfirmacion(base({ tramos: [] })).bloqueos[0].codigo === "sin_tramos", "10 sin reserva");
t(avisos(juzgarConfirmacion(base({ cotizacion: null }))).includes("igv_sin_dato"), "10 sin cotización no afirma IGV");
t(juzgarConfirmacion(base({ cotizacion: { ...base().cotizacion!, incluye_igv: false } })).datos!.economia.igv === "no_incluido", "10 IGV de la cotización");

// 11 y 12 (permisos y fallos) los cubre la ruta; aquí, lo que la ruta usa.
t(telefonoWa("987 654 321") === "51987654321" && telefonoWa("+51 987654321") === "51987654321" && telefonoWa("12") === null, "11 teléfono wa.me");
t(mensajeWhatsApp("es", "AFA", "X-V1").startsWith("Estimado/a cliente") && !/S\/|\d+\.\d\d/.test(mensajeWhatsApp("es", "AFA", "X")), "11 mensaje sin importes");

// Barrido: nunca un documento con importes inventados.
let barridos = 0;
for (const p1 of [0, 120, null]) for (const p2 of [0, 80, null]) for (const est of ["programada", "cancelada"]) for (const pago of [0, 50, 500]) for (const cred of [false, true]) {
  const e = base({ tramos: [ida, { ...ret, precio_cliente: p2, estado: est }].map((x, i) => (i === 0 ? { ...x, precio_cliente: p1 } : x)),
    pagos: pago ? [{ id: 5, fecha: "2026-10-20", monto: pago, moneda: "PEN" }] : [],
    cliente: { ...base().cliente!, condicion_pago: cred ? "Crédito 15d" : "Contado" } });
  const j = juzgarConfirmacion(e);
  barridos++;
  if (j.ok) {
    const reg = (Number(p1) || 0) + (Number(p2) || 0);
    t(j.datos!.economia.total === reg && reg > 0, `barrido total ${p1}/${p2}`);
    t((Number(p1) || 0) === 0 || (Number(p2) || 0) === 0, `barrido nunca dos tramos con importe ${p1}/${p2}`);
    t(j.datos!.economia.adelanto <= j.datos!.economia.total && j.datos!.economia.saldo === Math.round((j.datos!.economia.total - j.datos!.economia.adelanto) * 100) / 100, "barrido saldo");
    t(pago > 0 || cred, "barrido sin cobro solo con crédito");
  }
}
t(barridos === 108, "barrido completo");

// El PDF: una hoja, en los dos idiomas, sin lanzar con caracteres raros.
const raro = juzgarConfirmacion(base({ asignaciones: asig, extras: { nota: "Llevar cartel → «Sr. Pérez» 😀 ✓", vuelo: "LA2045" } }));
for (const idioma of ["es", "en"] as const) {
  const d = docConfirmacion(raro.datos!, idioma, { version: 2, emitidoEn: "2026-10-21" }, emp);
  const bytes = await dibujarConfirmacion(d, { empresa: emp.nombre });
  const paginas = (await PDFDocument.load(bytes)).getPageCount();
  t(paginas === 1, `PDF ${idioma} de una hoja (${paginas})`);
  if (process.env.MUESTRA_DIR) writeFileSync(`${process.env.MUESTRA_DIR}/confirmacion-${idioma}.pdf`, bytes);
}
const largo = juzgarConfirmacion(base({ tramos: [ida, ret], asignaciones: asig, extras: { nota: "x ".repeat(150) } }));
const bytesL = await dibujarConfirmacion(docConfirmacion(largo.datos! as DatosConfirmacion, "es", { version: 1, emitidoEn: "2026-10-21" }, emp), { empresa: "AFA" });
t(bytesL.length > 1000, "PDF ida y retorno con nota larga");
const ir = juzgarConfirmacion(base({ tramos: [ida, ret], asignaciones: { 100: asig[100], 101: { vehiculo: { placa: "B8H-967" }, conductor: { nombre: "Ana Soto" } } }, extras: { vuelo: "LA2045", punto_encuentro: "Llegadas", nota: "Llevar cartel con el nombre del pasajero." } }));
const bytesIr = await dibujarConfirmacion(docConfirmacion(ir.datos!, "en", { version: 3, emitidoEn: "2026-10-21" }, emp), { empresa: "AFA" });
if (process.env.MUESTRA_DIR) writeFileSync(`${process.env.MUESTRA_DIR}/confirmacion-ida-retorno-en.pdf`, bytesIr);
const pagIr = (await PDFDocument.load(bytesIr)).getPageCount();
t(pagIr === 1, `PDF ida y retorno completo en una hoja (${pagIr})`);
if (process.env.MUESTRA_DIR) writeFileSync(`${process.env.MUESTRA_DIR}/confirmacion-ida-retorno.pdf`, bytesL);

console.log(`\n${ok} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
