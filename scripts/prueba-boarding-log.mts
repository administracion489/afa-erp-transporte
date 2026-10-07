// scripts/prueba-boarding-log.mts — Matriz de lib/boarding-log.ts.
//   npx tsx scripts/prueba-boarding-log.mts
//
// Lo que fija, y por qué cada cosa:
//  1. El payload VIEJO (copiado literal de los dos escritores) lleva una clave que la tabla no
//     tiene: reproduce el defecto. Si deja de hacerlo, el escenario dejó de ser el que se rompió.
//  2. La fila nueva lleva SOLO columnas de `boarding_log` y no manda la hora (la pone la base).
//  3. Sin pasajero o sin paradero no se escribe nada; sin servicio, sí (reserva_id es nullable).
//  4. El `{ error }` de supabase-js SE LEE: devuelve false y deja un aviso en el log. Un cliente
//     que LANZA tampoco rompe: el embarque nunca depende de la bitácora.

import { COLUMNAS_BOARDING_LOG, filaBoardingLog, registrarAbordaje, METODO_QR_CONDUCTOR } from "../lib/boarding-log";

let ok = 0, fallos = 0;
const check = (cond: unknown, msg: string) => {
  if (cond) ok++; else { fallos++; console.log("  ✗", msg); }
};
const sec = (t: string) => console.log(`\n── ${t}`);
const COLUMNAS = new Set<string>(COLUMNAS_BOARDING_LOG);
const clavesAjenas = (fila: Record<string, unknown>) => Object.keys(fila).filter(k => !COLUMNAS.has(k));

// ── 1. El algoritmo viejo reproduce el defecto ───────────────────────────────
sec("1. El payload viejo manda una columna que la tabla no tiene");
{
  const pasajero_id = 7, parada_id = 9, reserva_id: number | null = 3;
  const viejo = {
    pasajero_id, parada_id, reserva_id: reserva_id ?? null,
    metodo: "qr_conductor", created_at: new Date().toISOString(),
  };
  check(clavesAjenas(viejo).join() === "created_at", `viejo: claves ajenas = ${clavesAjenas(viejo)}`);
}

// ── 2. La fila nueva ─────────────────────────────────────────────────────────
sec("2. La fila nueva solo lleva columnas de boarding_log");
{
  const f = filaBoardingLog(7, 9, 3)!;
  check(f && clavesAjenas(f).length === 0, `claves ajenas: ${f && clavesAjenas(f)}`);
  check(!("timestamp" in f) && !("created_at" in f), "la hora la pone la base");
  check(f.pasajero_id === 7 && f.parada_id === 9 && f.reserva_id === 3, "ids tal cual");
  check(f.metodo === METODO_QR_CONDUCTOR && METODO_QR_CONDUCTOR === "qr_conductor", "método qr_conductor (lo lee el portal)");
  const s = filaBoardingLog("7", "9", "3")!;
  check(s?.pasajero_id === 7 && s.parada_id === 9 && s.reserva_id === 3, "acepta ids en texto y los vuelve número");
}

// ── 3. Qué no se escribe ─────────────────────────────────────────────────────
sec("3. Sin pasajero o sin paradero no hay fila; sin servicio, sí");
{
  const malos: unknown[] = [null, undefined, 0, -1, NaN, "", "abc"];
  for (const m of malos) {
    check(filaBoardingLog(m, 9, 3) === null, `pasajero ${String(m)} → null`);
    check(filaBoardingLog(7, m, 3) === null, `paradero ${String(m)} → null`);
    const sinReserva = filaBoardingLog(7, 9, m);
    check(sinReserva !== null && sinReserva.reserva_id === null, `reserva ${String(m)} → fila con reserva_id null`);
  }
}

// ── 4. El error se lee ───────────────────────────────────────────────────────
sec("4. registrarAbordaje lee el { error } y nunca lanza");
type Llamada = { tabla: string; fila: Record<string, unknown> };
const cliente = (resp: () => Promise<{ error: any }>) => {
  const llamadas: Llamada[] = [];
  const c = { from(tabla: string) { return { insert(fila: Record<string, unknown>) { llamadas.push({ tabla, fila }); return resp(); } }; } };
  return { c: c as any, llamadas };
};
const avisos: string[] = [];
const warnOriginal = console.warn;
console.warn = (...a: unknown[]) => { avisos.push(a.map(String).join(" ")); };
try {
  {
    const { c, llamadas } = cliente(async () => ({ error: null }));
    const r = await registrarAbordaje(c, 7, 9, 3, "prueba");
    check(r === true, "éxito → true");
    check(llamadas.length === 1 && llamadas[0].tabla === "boarding_log", "un insert a boarding_log");
    check(clavesAjenas(llamadas[0]?.fila ?? { x: 1 }).length === 0, "lo que viaja son columnas de la tabla");
    check(avisos.length === 0, "sin aviso cuando entra");
  }
  {
    avisos.length = 0;
    const { c } = cliente(async () => ({
      error: { code: "PGRST204", message: "Could not find the 'created_at' column of 'boarding_log' in the schema cache" },
    }));
    const r = await registrarAbordaje(c, 7, 9, 3, "prueba");
    check(r === false, "{ error } → false (antes se daba por escrito)");
    check(avisos.length === 1 && avisos[0].includes("[prueba]") && avisos[0].includes("PGRST204"), `aviso con origen y código: ${avisos[0]}`);
  }
  {
    avisos.length = 0;
    const { c } = cliente(async () => { throw new Error("red caída"); });
    let lanzo = false, r: boolean | undefined;
    try { r = await registrarAbordaje(c, 7, 9, 3, "prueba"); } catch { lanzo = true; }
    check(!lanzo && r === false, "excepción → false, sin lanzar");
    check(avisos.length === 1 && avisos[0].includes("red caída"), "la excepción también se avisa");
  }
  {
    avisos.length = 0;
    const { c, llamadas } = cliente(async () => ({ error: null }));
    const r = await registrarAbordaje(c, null, 9, 3, "prueba");
    check(r === false && llamadas.length === 0, "sin pasajero no llama a la base");
  }
} finally {
  console.warn = warnOriginal;
}

console.log(`\n${fallos ? "✗" : "✓"} ${ok} comprobaciones OK, ${fallos} fallos`);
if (fallos) process.exit(1);
