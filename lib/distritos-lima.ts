// lib/distritos-lima.ts
// Distritos de Lima Metropolitana + Callao y su vecindad, para sugerir "el proveedor más
// cercano" cuando no hay ninguno exacto en el distrito pedido (ver /tercerizadas).
//
// Es un mapa hecho a mano según la geografía conocida de Lima — NO son límites catastrales
// oficiales ni viene de una fuente GIS. El objetivo es solo dar una idea razonable de
// cercanía para el despachador ("no hay nadie en San Martín de Porres, pero sí en Los
// Olivos, que es vecino"), no medir distancia exacta. Si algo se ve mal, se corrige acá
// mismo: son solo pares de nombres.

// Pares NO dirigidos: cada uno agrega la vecindad en ambos sentidos.
const PARES_VECINOS: [string, string][] = [
  // Lima Norte
  ["Ancón", "Santa Rosa"], ["Ancón", "Puente Piedra"], ["Ancón", "Carabayllo"],
  ["Santa Rosa", "Puente Piedra"],
  ["Puente Piedra", "Carabayllo"], ["Puente Piedra", "Comas"], ["Puente Piedra", "Ventanilla"],
  ["Carabayllo", "Comas"],
  ["Comas", "Los Olivos"], ["Comas", "Independencia"], ["Comas", "San Juan de Lurigancho"],
  ["Los Olivos", "Independencia"], ["Los Olivos", "San Martín de Porres"],
  ["Independencia", "San Martín de Porres"], ["Independencia", "Rímac"], ["Independencia", "San Juan de Lurigancho"],
  ["San Martín de Porres", "Rímac"], ["San Martín de Porres", "Cercado de Lima"],
  ["San Martín de Porres", "Callao"], ["San Martín de Porres", "Carmen de la Legua Reynoso"],

  // Callao
  ["Callao", "Bellavista"], ["Callao", "Carmen de la Legua Reynoso"], ["Callao", "La Perla"],
  ["Callao", "Ventanilla"], ["Callao", "Cercado de Lima"],
  ["Bellavista", "La Perla"], ["Bellavista", "Carmen de la Legua Reynoso"], ["Bellavista", "San Miguel"],
  ["Carmen de la Legua Reynoso", "San Martín de Porres"],
  ["La Perla", "La Punta"], ["La Perla", "San Miguel"],
  ["Ventanilla", "Mi Perú"],

  // Lima Centro
  ["Cercado de Lima", "Rímac"], ["Cercado de Lima", "Breña"], ["Cercado de Lima", "La Victoria"],
  ["Cercado de Lima", "El Agustino"], ["Cercado de Lima", "San Miguel"],
  ["Rímac", "San Juan de Lurigancho"],
  ["Breña", "Jesús María"], ["Breña", "Pueblo Libre"], ["Breña", "La Victoria"],
  ["La Victoria", "Lince"], ["La Victoria", "San Luis"], ["La Victoria", "El Agustino"], ["La Victoria", "San Isidro"],
  ["El Agustino", "San Luis"], ["El Agustino", "Santa Anita"], ["El Agustino", "San Juan de Lurigancho"], ["El Agustino", "Ate"],
  ["San Luis", "San Borja"], ["San Luis", "Santa Anita"],

  // Lima Moderna
  ["Jesús María", "Pueblo Libre"], ["Jesús María", "Lince"], ["Jesús María", "Magdalena del Mar"],
  ["Pueblo Libre", "Magdalena del Mar"], ["Pueblo Libre", "San Miguel"],
  ["Magdalena del Mar", "San Miguel"], ["Magdalena del Mar", "San Isidro"],
  ["Lince", "San Isidro"],
  ["San Isidro", "Magdalena del Mar"], ["San Isidro", "San Borja"], ["San Isidro", "Miraflores"], ["San Isidro", "Surquillo"],
  ["San Borja", "Surco"], ["San Borja", "Surquillo"], ["San Borja", "Ate"],
  ["Surquillo", "Miraflores"], ["Surquillo", "Surco"],
  ["Miraflores", "Surco"], ["Miraflores", "Barranco"],
  ["Surco", "Barranco"], ["Surco", "La Molina"], ["Surco", "San Juan de Miraflores"], ["Surco", "Chorrillos"],
  ["Barranco", "Chorrillos"],

  // Lima Este
  ["San Juan de Lurigancho", "Ate"], ["San Juan de Lurigancho", "Lurigancho"],
  ["Ate", "Santa Anita"], ["Ate", "La Molina"], ["Ate", "Cieneguilla"], ["Ate", "Chaclacayo"], ["Ate", "Lurigancho"],
  ["Santa Anita", "El Agustino"],
  ["La Molina", "Cieneguilla"], ["La Molina", "Pachacámac"],
  ["Cieneguilla", "Pachacámac"],
  ["Chaclacayo", "Lurigancho"],

  // Lima Sur
  ["Chorrillos", "San Juan de Miraflores"], ["Chorrillos", "Villa El Salvador"],
  ["San Juan de Miraflores", "Villa María del Triunfo"], ["San Juan de Miraflores", "Villa El Salvador"],
  ["Villa María del Triunfo", "Villa El Salvador"], ["Villa María del Triunfo", "Pachacámac"],
  ["Villa El Salvador", "Lurín"], ["Villa El Salvador", "Pachacámac"],
  ["Pachacámac", "Lurín"],
  ["Lurín", "Punta Hermosa"],
  ["Punta Hermosa", "Punta Negra"],
  ["Punta Negra", "San Bartolo"],
  ["San Bartolo", "Santa María del Mar"],
  ["Santa María del Mar", "Pucusana"],
];

/** Todos los distritos que aparecen en PARES_VECINOS, alfabético — para poblar el <select>. */
export const DISTRITOS_LIMA: string[] = [...new Set(PARES_VECINOS.flat())].sort((a, b) => a.localeCompare(b, "es"));

const VECINOS: Record<string, string[]> = {};
for (const [a, b] of PARES_VECINOS) {
  (VECINOS[a] ??= []).push(b);
  (VECINOS[b] ??= []).push(a);
}

/**
 * Cuántos "saltos" de vecindad hay entre dos distritos (0 = el mismo, 1 = vecino directo,
 * 2 = vecino de vecino...). `null` si alguno no está en el mapa o quedan a más de `maxHops`
 * — a partir de ahí ya no es realista llamarlo "cercano" para efectos de despacho.
 */
export function distanciaDistritos(a: string | null, b: string | null, maxHops = 3): number | null {
  if (!a || !b) return null;
  if (a === b) return 0;
  if (!VECINOS[a] || !VECINOS[b]) return null;

  let frontera = new Set([a]);
  const visitados = new Set([a]);
  for (let hop = 1; hop <= maxHops; hop++) {
    const siguiente = new Set<string>();
    for (const d of frontera) {
      for (const vecino of VECINOS[d] || []) {
        if (vecino === b) return hop;
        if (!visitados.has(vecino)) { visitados.add(vecino); siguiente.add(vecino); }
      }
    }
    frontera = siguiente;
    if (frontera.size === 0) break;
  }
  return null;
}

/** Etiqueta lista para mostrar en la UI a partir del resultado de distanciaDistritos(). */
export function etiquetaDistancia(hops: number | null, distritoObjetivo: string): string | null {
  if (hops === null) return null;
  if (hops === 0) return `🎯 En ${distritoObjetivo}`;
  if (hops === 1) return `📍 A 1 distrito de ${distritoObjetivo}`;
  return `📍 A ${hops} distritos de ${distritoObjetivo}`;
}
