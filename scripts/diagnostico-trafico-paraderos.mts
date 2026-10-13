// Diagnóstico (se corre A MANO, gasta 2 consultas «Directions Advanced» ≈ US$ 0.02):
//   GOOGLE_MAPS_API_KEY=... npx tsx scripts/diagnostico-trafico-paraderos.mts
//
// Comprueba contra la API real la premisa de /api/cotizaciones/horas-paraderos: que Google
// Directions (legacy) NO devuelve `duration_in_traffic` por tramo cuando la ruta lleva paradas
// intermedias, y que SÍ lo devuelve cuando los intermedios van como `via:` (un solo tramo).
// Si la primera consulta empieza a traer `duration_in_traffic` en cada leg, la ruta podría
// pedir toda la cadena en UNA llamada en vez de una por tramo — pero entonces el tráfico de
// cada tramo se consultaría a la hora de salida del PRIMERO, no a la de ese tramo.
//
// No escribe nada ni lee la base. La key no se imprime.

const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
if (!key) {
  console.error("Falta GOOGLE_MAPS_API_KEY en el entorno.");
  process.exit(1);
}

// Un recorrido real de Lima: Santa Anita → Puente Santa Anita → Ate → Planta Huachipa.
const puntos = [
  { nombre: "Santa Anita",          lat: -12.0436, lng: -76.9710 },
  { nombre: "Puente Santa Anita",   lat: -12.0560, lng: -76.9715 },
  { nombre: "Ate (Ceres)",          lat: -12.0300, lng: -76.9330 },
  { nombre: "Huachipa",             lat: -12.0170, lng: -76.9000 },
];

// Mañana a las 07:00 Lima (UTC-5), en segundos.
const ahora = Date.now();
const hoyLima = new Date(ahora - 5 * 3_600_000).toISOString().slice(0, 10);
const [y, m, d] = hoyLima.split("-").map(Number);
const salida = Math.floor(Date.UTC(y, m - 1, d + 1, 12, 0) / 1000);

async function consultar(waypoints: string) {
  const qs = new URLSearchParams({
    origin: `${puntos[0].lat},${puntos[0].lng}`,
    destination: `${puntos[puntos.length - 1].lat},${puntos[puntos.length - 1].lng}`,
    waypoints,
    mode: "driving",
    departure_time: String(salida),
    traffic_model: "best_guess",
    language: "es",
    region: "pe",
    key: key!,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${qs}`);
  const data: any = await res.json();
  return { http: res.status, status: data.status, legs: (data.routes?.[0]?.legs || []) as any[], error: data.error_message };
}

console.log(`Salida consultada: ${new Date(salida * 1000).toISOString()} (mañana 07:00 Lima)\n`);

const intermedios = puntos.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join("|");
const conParadas = await consultar(intermedios);
console.log(`1) Con paradas intermedias (stopover): HTTP ${conParadas.http} · ${conParadas.status}${conParadas.error ? " · " + conParadas.error : ""}`);
conParadas.legs.forEach((l, i) =>
  console.log(`   leg ${i + 1}: duration ${l.duration?.value ?? "—"} s · duration_in_traffic ${l.duration_in_traffic?.value ?? "AUSENTE"}`));
const traePorTramo = conParadas.legs.length > 0 && conParadas.legs.every((l) => l.duration_in_traffic);

const via = puntos.slice(1, -1).map((p) => `via:${p.lat},${p.lng}`).join("|");
const conVia = await consultar(via);
console.log(`\n2) Con intermedios como via: HTTP ${conVia.http} · ${conVia.status}${conVia.error ? " · " + conVia.error : ""}`);
conVia.legs.forEach((l, i) =>
  console.log(`   leg ${i + 1}: duration ${l.duration?.value ?? "—"} s · duration_in_traffic ${l.duration_in_traffic?.value ?? "AUSENTE"}`));

console.log(`\nVEREDICTO: ${traePorTramo
  ? "Google SÍ trae duration_in_traffic por tramo con paradas intermedias: la premisa cambió; revisar /api/cotizaciones/horas-paraderos."
  : "Google NO trae duration_in_traffic por tramo con paradas intermedias: se mantiene una consulta por tramo."}`);
