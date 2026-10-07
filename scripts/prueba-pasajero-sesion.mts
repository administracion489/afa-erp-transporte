// scripts/prueba-pasajero-sesion.mts — Matriz de lib/pasajero-sesion.ts.
// Correr: npx tsx scripts/prueba-pasajero-sesion.mts
//
// Fija las dos promesas del módulo:
//   1. La sesión guardada en el teléfono vence cuando vence el token, NUNCA después (el defecto:
//      cada refresco la estiraba a «ahora + 24 h» y la app quedaba «logueada» con todo en 401).
//   2. Solo el 401 MARCADO desloguea; el de la llave x-afa-key no (re-ingresar no lo arregla y el
//      pasajero entraría en un bucle).

import { firmarTokenPasajero } from "../lib/pasajero-auth";
import {
  AVISO_SESION_VENCIDA, CUERPO_SESION_INVALIDA, esSesionInvalida, expDeToken, vencimientoSesion,
} from "../lib/pasajero-sesion";

let fallos = 0, total = 0;
function ok(cond: boolean, nombre: string) {
  total++;
  if (!cond) { fallos++; console.log(`  ✗ ${nombre}`); }
  else console.log(`  ✓ ${nombre}`);
}

const H = 3_600_000;

console.log("\n1. El vencimiento sale del token");
{
  const antes = Date.now();
  const t = firmarTokenPasajero(7, 60_000);
  const exp = expDeToken(t);
  ok(exp !== null && Math.abs(exp - (antes + 60_000)) < 2_000, "expDeToken lee el exp que firmó el servidor");
}
ok(expDeToken("basura") === null, "texto sin punto → null");
ok(expDeToken(null) === null, "null → null");
ok(expDeToken("a.b") === null, "payload ilegible → null");
ok(expDeToken(123) === null, "no-texto → null");

console.log("\n2. La sesión guardada nunca dura más que el token");
{
  const ahora = Date.now();
  const t1h = firmarTokenPasajero(7, H);
  const expTok = expDeToken(t1h)!;
  ok(vencimientoSesion(ahora + 48 * H, t1h) === expTok,
    "guardado estirado a 48 h con token de 1 h → manda el token (el defecto)");
  ok(vencimientoSesion(ahora + 10_000, t1h) === ahora + 10_000, "guardado menor que el token → manda lo guardado");
  ok(vencimientoSesion(undefined, t1h) === expTok, "sin guardado → el del token");
  ok(vencimientoSesion(ahora + H, "ilegible") === ahora + H, "token ilegible → lo guardado");
  ok(vencimientoSesion(undefined, "ilegible") === 0, "ni guardado ni token → vencida (0)");
  // El escenario completo: token vencido hace 1 h con la sesión estirada un día → vencida al abrir.
  const vencido = firmarTokenPasajero(7, -H);
  ok(Date.now() > vencimientoSesion(ahora + 24 * H, vencido), "token vencido + sesión estirada → la app la da por vencida");
}

console.log("\n3. Solo el 401 marcado desloguea");
ok(esSesionInvalida(401, CUERPO_SESION_INVALIDA), "401 con la marca → sesión inválida");
ok(!esSesionInvalida(401, { error: "No autorizado" }), "401 de la llave x-afa-key → NO desloguea");
ok(!esSesionInvalida(200, CUERPO_SESION_INVALIDA), "200 con la marca → no");
ok(!esSesionInvalida(401, null), "401 sin cuerpo → no");
ok(!esSesionInvalida(403, CUERPO_SESION_INVALIDA), "403 → no");
ok(CUERPO_SESION_INVALIDA.error === AVISO_SESION_VENCIDA, "el cuerpo lleva el mismo aviso que pinta la app");

console.log(`\n${total - fallos}/${total} ${fallos ? "— FALLA" : "✓"}`);
if (fallos) process.exit(1);
