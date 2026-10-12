// lib/turno-calculo.ts — Tope de cálculos pesados a la vez, por instancia, con cola acotada.
//
// Es el patrón `turno` de app/api/seguimiento/rastreo/route.ts y de su /diagnostico, sacado a un
// módulo para que las rutas nuevas de analítica (lib/flota/*) no lo copien una cuarta vez. Las rutas
// viejas NO se tocan: siguen con su copia, que es exactamente esto.
//
// LAS DOS REGLAS QUE LO HACEN CORRECTO:
//   · EL CUPO SE TRASPASA, NO SE SUELTA. Al terminar, si hay alguien esperando se le pasa el cupo
//     directamente sin decrementar el contador: si se soltara primero, una petición nueva podría
//     colarse entre medias y pasar del tope.
//   · LA COLA TIENE TECHO. Esperar es lo correcto para una persona que pulsa un botón (un rechazo al
//     primer intento se lee como «está roto»), pero cientos de peticiones a la vez no pueden encolar
//     cientos de lecturas pesadas: pasado `maxCola` se lanza `ColaLlena` y la ruta responde 503 con
//     `reintentar`.
//
// Cada llamada a `crearTurno` es un turno INDEPENDIENTE (su propio contador y su propia cola): una
// ruta lo crea una vez a nivel de módulo.

/** Hay más de `maxCola` cálculos esperando: la ruta debería responder 503 con `reintentar`. */
export class ColaLlena extends Error {
  constructor() {
    super("Hay demasiados cálculos esperando; reintenta en unos segundos.");
    this.name = "ColaLlena";
  }
}

/**
 * Un turno con a lo sumo `max` cálculos corriendo a la vez y a lo sumo `maxCola` esperando.
 * Devuelve la función que envuelve cada cálculo: `const turno = crearTurno(2, 20); await turno(() => calcular())`.
 */
export function crearTurno(max: number, maxCola: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const tope = Math.max(1, Math.floor(max));
  const topeCola = Math.max(0, Math.floor(maxCola));
  let calculando = 0;
  const cola: (() => void)[] = [];
  return async function turno<T>(fn: () => Promise<T>): Promise<T> {
    if (calculando >= tope) {
      if (cola.length >= topeCola) throw new ColaLlena();
      await new Promise<void>((ok) => cola.push(ok));
    } else calculando++;
    try { return await fn(); }
    finally { const siguiente = cola.shift(); if (siguiente) siguiente(); else calculando--; }
  };
}
