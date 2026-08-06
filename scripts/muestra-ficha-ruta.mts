// Genera una muestra de la Ficha Técnica de Ruta con datos ficticios, para revisar
// el diseño sin sesión ni datos reales. Uso: npx tsx <este archivo>
import fs from "node:fs";
import path from "node:path";
import { construirPuntos, puntosConCoords, urlMapaEstatico, urlGoogleMapsRuta, firmaRutaFicha, encodePolyline, diezmar, type PuntoFicha, type MetricaSentido } from "../lib/ficha-ruta";
import { buildFichaRutaHtml } from "../lib/ficha-ruta-html";

const RAIZ = "C:/Users/trans/afa-erp-transporte";
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const TOKEN = (/NEXT_PUBLIC_MAPBOX_TOKEN=(.+)/.exec(env)?.[1] || "").trim();

const paradasIda = [
  { tipo: "inicio", nombre: "Óvalo La Curva", direccion: "Óvalo La Curva, Chorrillos 15056", lat: "-12.17462", lng: "-77.01654", hora: "20:15" },
  { tipo: "intermedia", nombre: "Paradero Matellini", direccion: "Av. Guardia Civil 1250, Chorrillos", lat: "-12.18122", lng: "-76.99852", hora: "" },
  { tipo: "intermedia", nombre: "Puente Benavides", direccion: "Av. Paseo de la República, Surco", lat: "-12.12735", lng: "-77.01251", hora: "20:40" },
  { tipo: "intermedia", nombre: "Plaza San Miguel", direccion: "Av. La Marina 2000, San Miguel", lat: "-12.07714", lng: "-77.08283", hora: "" },
  { tipo: "destino", nombre: "Mixing Center Callao", direccion: "D, XVXJ+5GV, Callao 07031", lat: "-12.03514", lng: "-77.11423", hora: "21:30" },
];
const paradasRet = [
  { tipo: "inicio", nombre: "Mixing Center Callao", direccion: "D, XVXJ+5GV, Callao 07031", lat: "-12.03514", lng: "-77.11423", hora: "22:30" },
  { tipo: "intermedia", nombre: "Av. Universitaria", direccion: "Av. Universitaria 1801, San Miguel", lat: "-12.07026", lng: "-77.08037", hora: "" },
  { tipo: "destino", nombre: "Defensores del Morro", direccion: "Av. Defensores del Morro Lt 17-18, Chorrillos 15000", lat: "-12.17053", lng: "-77.01911", hora: "23:45" },
];

const pIda = construirPuntos(paradasIda, "I");
const pRet = construirPuntos(paradasRet, "R");

// Con un servidor de la app corriendo se piden las métricas reales (mismo camino que la
// página); sin él se usan valores de ejemplo, que alcanzan para revisar el diseño.
const API = process.argv[2] || "";
async function metricaReal(puntos: PuntoFicha[]): Promise<MetricaSentido | null> {
  const con = puntosConCoords(puntos);
  if (!API || con.length < 2) return null;
  const r = await fetch(`${API}/api/ruta`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paradas: con.map(p => ({ nombre: p.nombre, lat: p.lat, lng: p.lng })), conTrafico: false }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return { poly: encodePolyline(diezmar(d.coordenadas as [number, number][], 160)), tramos: d.tramos.map((t: any) => ({ distancia_km: t.distancia_km, duracion_min: t.duracion_min })), total_km: d.total_km, total_min: d.total_min };
}
const EJEMPLO_IDA: MetricaSentido = { poly: "", tramos: [{ distancia_km: 3.2, duracion_min: 9 }, { distancia_km: 7.8, duracion_min: 18 }, { distancia_km: 11.4, duracion_min: 24 }, { distancia_km: 6.1, duracion_min: 16 }], total_km: 28.5, total_min: 67 };
const EJEMPLO_RET: MetricaSentido = { poly: "", tramos: [{ distancia_km: 5.9, duracion_min: 14 }, { distancia_km: 21.3, duracion_min: 41 }], total_km: 27.2, total_min: 55 };
const metrica = {
  firma: firmaRutaFicha(pIda, pRet),
  calculado_at: new Date(2026, 7, 6).toISOString(),
  ida: (await metricaReal(pIda)) || EJEMPLO_IDA,
  retorno: (await metricaReal(pRet)) || EJEMPLO_RET,
};

const urlRuta = urlGoogleMapsRuta(pIda);
const QRCode = (await import("qrcode")).default;
const qr = await QRCode.toDataURL(urlRuta, { margin: 1, width: 240 });

const html = buildFichaRutaHtml({
  nCot: "00365", anio: 2026, emitida: "06/08/2026",
  cliente: { nombre: "SNACKS AMERICA LATINA S.R.L.", docLabel: "RUC", doc: "20297182456", contacto: "Jhon Santana", telefono: "998 112 233" },
  servicio: { ruta: "TRANSPORTE DE PERSONAL - Mixing Center (Callao)", modalidad: "Servicio fijo (recurrente) · Ida y Retorno", inicio: "20 DE JULIO DE 2026", retornoLabel: "VIGENCIA", retorno: "Según programación acordada" },
  horaIda: "20:15", horaRetorno: "22:30",
  puntosIda: pIda, puntosRet: pRet, metrica,
  mapaIda: urlMapaEstatico(pIda, metrica.ida.poly, "#0b315f", TOKEN),
  mapaRet: urlMapaEstatico(pRet, metrica.retorno.poly, "#6d28d9", TOKEN),
  qr, urlRuta,
  unidadTexto: "Custer 25 pax · 25 pasajeros · Full equipo",
  unidadDetalle: "B2K-885 · Hyundai County · 25 pax   |   D4T-712 · Mercedes Benz Sprinter · 19 pax",
  empresa: { nombre: "AFA Tours Peru S.A.C.", email: "transporte@afatoursperu.com", telefono: "(01) 3453707 – 966 707 225", web: "www.afatoursperu.com", direccion: "Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana · Lima", logo: `file:///${RAIZ}/public/logoafacotizacion-removebg-preview.png` },
  repr: "JENNY URBINA", aviso: "",
});

const salida = path.join(process.env.TEMP || ".", "ficha-ruta-muestra.html");
fs.writeFileSync(salida, html, "utf8");
console.log("Token Mapbox:", TOKEN ? "OK" : "FALTA", "| API:", API || "(métricas de ejemplo)");
console.log("Puntos ida con coords:", puntosConCoords(pIda).length, "| retorno:", puntosConCoords(pRet).length);
console.log("HTML:", salida);
