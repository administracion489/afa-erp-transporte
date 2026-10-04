// Matriz de lib/busqueda-texto.ts. Uso: npx tsx scripts/prueba-busqueda-texto.mts
import { coincideBusqueda, terminosBusqueda } from "../lib/busqueda-texto";

let fallos = 0;
const caso = (texto: string, q: string, esperado: boolean) => {
  const r = coincideBusqueda(texto, terminosBusqueda(q));
  if (r !== esperado) { fallos++; console.log(`✗ "${q}" en "${texto}" → ${r}, se esperaba ${esperado}`); }
  else console.log(`✓ "${q}" en "${texto}" → ${r}`);
};

// El caso reportado: mayúsculas sin tilde contra la ficha con tilde.
caso("Compañía Hard Rock S.A.C.", "COMPAÑIA HARD", true);
caso("COMPAÑÍA HARD ROCK", "compania hard", true);
caso("Compañía Hard Rock", "hard comp", true);          // cualquier orden, trozos
caso("Compañía Hard Rock S.A.C.", "sac", true);         // puntos
caso("OS-2026-006532 25525", "OS-2026-006532", true);   // código con guiones
caso("OS-2026-006532 25525", "006532", true);
caso("RUTA C/ENTRADA 06:35", "ruta c entrada", true);
caso("cualquier cosa", "", true);                       // vacío deja pasar
caso("cualquier cosa", "   ", true);
caso("ABC-123 Mercedes Sprinter", "abc123", true);      // placa sin guion
caso("ABC-123 Mercedes Sprinter", "ABC 123", true);
caso("Juan Pérez Q-12345678 A-IIIb", "perez q12345678", true);
// Lo que NO debe pasar: todas las palabras tienen que estar.
caso("Compañía Hard Rock", "compania soft", false);
caso("SNACKS AMERICA LATINA", "compania", false);

if (fallos) { console.log(`\n${fallos} fallo(s)`); process.exit(1); }
console.log("\nTodo verde");
