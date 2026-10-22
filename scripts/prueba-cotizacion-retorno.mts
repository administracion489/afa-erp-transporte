// npx tsx scripts/prueba-cotizacion-retorno.mts
import { planRetorno, horaValida, type CotParaRetorno } from "../lib/cotizacion-retorno";

let ok = 0, mal = 0;
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; console.log("✗", n); } };

// El caso real: cotización #736.
const c736: CotParaRetorno = {
  modo_servicio: "eventual", tipo_servicio: "ida_retorno",
  origen: "Aeropuerto Internacional Jorge Chávez", destino: "Hotel Paracas", punto_retorno: "JW Marriott Lima",
  fecha_servicio: "2026-10-22", fecha_retorno: "2026-10-23", hora_retorno: "14:30",
  paradas_retorno_json: [
    { tipo: "inicio", nombre: "Hotel Paracas", lat: "-13.83", lng: "-76.25", hora: "14:30" },
    { tipo: "destino", nombre: "JW Marriott Lima", lat: "-12.13", lng: "-77.02", hora: "" },
  ],
};
const p = planRetorno(c736, "2026-10-22");
t("736 ok", p.codigo === "ok");
if (p.codigo === "ok") {
  t("736 fecha 23", p.fecha === "2026-10-23");
  t("736 hora", p.hora === "14:30");
  t("736 origen Paracas", p.origen === "Hotel Paracas");
  t("736 destino Marriott", p.destino === "JW Marriott Lima");
  t("736 coords", p.paradas[1].lat === -12.13 && p.paradas[1].lng === -77.02);
}

// No aplica.
for (const tipo of ["solo_ida", "full_day", "multi_dia", null]) t(`no aplica ${tipo}`, planRetorno({ ...c736, tipo_servicio: tipo }, "2026-10-22").codigo === "no_aplica");
t("fijo no aplica", planRetorno({ ...c736, modo_servicio: "fijo", tipo_servicio: "ida_retorno" }, "2026-10-22").codigo === "no_aplica");

// Sin lista de retorno: extremos, con punto de retorno y sin él (vuelve al origen).
const sinLista = { ...c736, paradas_retorno_json: null, ruta_coords_json: { v: 1, origen: { lat: -12.02, lng: -77.11 }, destino: { lat: -13.83, lng: -76.25 }, retorno: { lat: -12.13, lng: -77.02 } } };
const p2 = planRetorno(sinLista, "2026-10-22");
t("extremos ok", p2.codigo === "ok" && p2.origen === "Hotel Paracas" && p2.destino === "JW Marriott Lima" && p2.paradas[1].lat === -12.13 && p2.paradas[0].hora === "14:30");
const p3 = planRetorno({ ...sinLista, punto_retorno: "" }, "2026-10-22");
t("vuelve al origen", p3.codigo === "ok" && p3.destino === "Aeropuerto Internacional Jorge Chávez" && p3.paradas[1].lat === -12.02);
const p3b = planRetorno({ ...sinLista, ruta_coords_json: null }, "2026-10-22");
t("sin coords: paradas sin coordenadas, no inventadas", p3b.codigo === "ok" && p3b.paradas.every((x) => x.lat === null));

// Sin hora: no se inventa.
t("sin hora", planRetorno({ ...sinLista, hora_retorno: "" }, "2026-10-22").codigo === "sin_hora");
t("hora inválida", planRetorno({ ...sinLista, hora_retorno: "25:00" }, "2026-10-22").codigo === "sin_hora");
// La hora del primer paradero manda sobre hora_retorno.
const p4 = planRetorno({ ...c736, hora_retorno: "09:00" }, "2026-10-22");
t("paradero manda", p4.codigo === "ok" && p4.hora === "14:30");
// Sin fecha de retorno: la del servicio.
const p5 = planRetorno({ ...c736, fecha_retorno: null }, "2026-10-22");
t("misma fecha", p5.codigo === "ok" && p5.fecha === "2026-10-22");
t("fecha anterior", planRetorno({ ...c736, fecha_retorno: "2026-10-20" }, "2026-10-22").codigo === "fecha_anterior");
// Orden por tipo, aunque la lista venga desordenada.
const p6 = planRetorno({ ...c736, paradas_retorno_json: [
  { tipo: "destino", nombre: "C", hora: "" }, { tipo: "intermedia", nombre: "B", hora: "15:00" }, { tipo: "inicio", nombre: "A", hora: "14:00" }] }, "2026-10-22");
t("orden", p6.codigo === "ok" && p6.paradas.map((x) => x.nombre).join("") === "ABC" && p6.paradas.map((x) => x.orden).join("") === "123");
t("sin destino", planRetorno({ ...c736, paradas_retorno_json: null, destino: "", punto_retorno: "" }, "2026-10-22").codigo === "sin_destino");
t("horaValida", horaValida("9:05") === "09:05" && horaValida("14:30:00") === "14:30" && horaValida("x") === null);

console.log(`\n${ok} ok · ${mal} fallos`);
if (mal) process.exit(1);
