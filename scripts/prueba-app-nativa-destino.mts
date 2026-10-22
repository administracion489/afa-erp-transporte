// npx tsx scripts/prueba-app-nativa-destino.mts
// Dentro del APK nunca se enseña el «Login ERP»: se vuelve a la app. En el navegador, nada cambia.
import { appDeRuta, destinoAppNativa } from "../lib/app-nativa-destino";

let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };

ok(appDeRuta("/conductor") === "/conductor", "/conductor es la app del conductor");
ok(appDeRuta("/conductor/x") === "/conductor", "sub-ruta del conductor");
ok(appDeRuta("/conductor-tercero/abc") === null, "/conductor-tercero no es el APK");
ok(appDeRuta("/pasajero") === "/pasajero", "/pasajero");
ok(appDeRuta("/login") === null && appDeRuta("/") === null, "ERP no es una app");

const base = { nativa: true, esRutaPublica: false, guardado: null as string | null, tieneAfaNative: false };
ok(destinoAppNativa({ ...base, guardado: "/conductor" }) === "/conductor", "APK conductor en /login vuelve a /conductor");
ok(destinoAppNativa({ ...base, guardado: "/pasajero" }) === "/pasajero", "APK pasajero vuelve a /pasajero");
ok(destinoAppNativa({ ...base, tieneAfaNative: true }) === "/conductor", "sin recuerdo, el plugin AfaNative dice conductor");
ok(destinoAppNativa({ ...base, guardado: "/pasajero", tieneAfaNative: true }) === "/pasajero", "lo recordado manda");
ok(destinoAppNativa(base) === null, "nativa sin pista: no se adivina");
ok(destinoAppNativa({ ...base, guardado: "/dashboard" }) === null, "un valor raro guardado no se obedece");
ok(destinoAppNativa({ ...base, guardado: "/conductor", esRutaPublica: true }) === null, "en una ruta pública no se toca");

// Barrido: en el navegador NUNCA se redirige.
for (const pub of [true, false]) for (const g of [null, "/conductor", "/pasajero", "x"]) for (const a of [true, false])
  if (destinoAppNativa({ nativa: false, esRutaPublica: pub, guardado: g, tieneAfaNative: a }) !== null) { fallos++; console.log("✗ navegador redirigido", pub, g, a); }
console.log("✓ en el navegador nunca se redirige");

if (fallos) { console.log(`\n${fallos} fallo(s)`); process.exit(1); }
console.log("\nTodo en verde");
