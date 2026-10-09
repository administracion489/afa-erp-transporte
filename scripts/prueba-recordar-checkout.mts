// Pruebas del recordatorio de CHECK-OUT (lib/alertas-checkout.ts). No tocan la base.
// Uso:  npx tsx scripts/prueba-recordar-checkout.mts
import {
  planRecordarCheckout, cadenciaEfectiva, escalaAlDirectorio,
  TOLERANCIA_LECTURA_ANTES_MS, ESCALAR_TRAS_RECORDATORIOS,
  type ServicioCheckout, type LecturaCheckout,
} from "../lib/alertas-checkout";

let fallos = 0;
const chk = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "  ok  " : "FALLA "} ${n}${extra ? " — " + extra : ""}`); if (!ok) fallos++; };

const MIN = 60_000;
const T = Date.parse("2026-10-08T22:00:00Z"); // 17:00 Lima: fin del último servicio
const srv = (o: Partial<ServicioCheckout> = {}): ServicioCheckout => ({ estado: "finalizada", finMs: T, vehiculo: "propio:7", ...o });
const plan = (o: Partial<Parameters<typeof planRecordarCheckout>[0]> = {}) => planRecordarCheckout({
  servicios: [srv({ finMs: T - 6 * 60 * MIN }), srv()],
  checkoutHecho: false, lecturas: [], ahoraMs: T + 6 * MIN, esperaMin: 5, cadenciaMin: 60, ...o,
});

// ── 1. El caso pedido: cerró el último servicio, pasaron 5 min, no mandó nada ─────────────
{
  const p = plan();
  chk("a los 6 min del último servicio, sin odómetro → recordar (ronda 0)", p.codigo === "recordar" && p.ronda === 0 && p.turno === "r0");
  chk("…y nombra la unidad del ÚLTIMO servicio", p.vehiculo === "propio:7");
  chk("a los 4 min todavía no", plan({ ahoraMs: T + 4 * MIN }).codigo === "en_espera");
  chk("a los 64 min sigue en la misma ronda (no se repite antes de la hora)", plan({ ahoraMs: T + 64 * MIN }).turno === "r0");
  chk("a los 65 min → segunda ronda", plan({ ahoraMs: T + 65 * MIN }).turno === "r1");
  chk("a las 3 h 5 min → cuarta ronda", plan({ ahoraMs: T + 185 * MIN }).ronda === 3);
}

// ── 2. Lo que lo APAGA ───────────────────────────────────────────────────────────────────
{
  chk("hizo el check-out en la app → no se recuerda", plan({ checkoutHecho: true }).codigo === "ya_checkout");
  const delGrupo: LecturaCheckout = { vehiculo: "propio:7", ts: T + 3 * MIN, anulada: false };
  chk("mandó la foto del tablero al GRUPO (lectura del Radar) → no se recuerda", plan({ lecturas: [delGrupo] }).codigo === "odometro_recibido");
  chk("…aunque la lectura quede por revisar (cumplió: revisarla es de la oficina)", plan({ lecturas: [{ ...delGrupo }] }).codigo === "odometro_recibido");
  chk("una lectura ANULADA no cuenta", plan({ lecturas: [{ ...delGrupo, anulada: true }] }).codigo === "recordar");
  chk("una lectura de OTRA unidad no cuenta", plan({ lecturas: [{ ...delGrupo, vehiculo: "propio:8" }] }).codigo === "recordar");
  chk("la foto mandada al llegar, poco antes de cerrar el servicio en la app, cuenta",
    plan({ lecturas: [{ ...delGrupo, ts: T - TOLERANCIA_LECTURA_ANTES_MS + MIN }] }).codigo === "odometro_recibido");
  chk("la lectura de la MAÑANA (check-in) no apaga el recordatorio",
    plan({ lecturas: [{ ...delGrupo, ts: T - 10 * 60 * MIN }] }).codigo === "recordar");
}

// ── 3. Los huecos del bloque viejo ──────────────────────────────────────────────────────
{
  const conCancelado = plan({ servicios: [srv(), srv({ estado: "cancelada", finMs: null })] });
  chk("un servicio CANCELADO ya no bloquea el recordatorio (antes lo apagaba todo el día)", conCancelado.codigo === "recordar");
  chk("todos cancelados → no hay jornada que cerrar", plan({ servicios: [srv({ estado: "cancelada" })] }).codigo === "sin_servicios");
  chk("con un servicio aún en curso, todavía no terminó su día",
    plan({ servicios: [srv(), srv({ estado: "en_curso", finMs: T + 60 * MIN })] }).codigo === "servicios_abiertos");
  chk("con uno pendiente sin iniciar, tampoco", plan({ servicios: [srv(), srv({ estado: "programada" })] }).codigo === "servicios_abiertos");
  const dosUnidades = plan({ servicios: [srv({ vehiculo: "propio:7", finMs: T - 60 * MIN }), srv({ vehiculo: "tercero:3", finMs: T })] });
  chk("cambió de unidad en el día → se pide el odómetro de la ÚLTIMA", dosUnidades.vehiculo === "tercero:3");
  chk("…y la lectura de la primera unidad no la apaga",
    planRecordarCheckout({ servicios: [srv({ vehiculo: "propio:7", finMs: T - 60 * MIN }), srv({ vehiculo: "tercero:3" })], checkoutHecho: false,
      lecturas: [{ vehiculo: "propio:7", ts: T, anulada: false }], ahoraMs: T + 10 * MIN, esperaMin: 5, cadenciaMin: 60 }).codigo === "recordar");
}

// ── 4. La cadencia es la de la pantalla (/auditoria-jornada) ────────────────────────────
{
  chk("cada 30 min → a los 40 min ya va por la segunda", plan({ ahoraMs: T + 40 * MIN, cadenciaMin: 30 }).turno === "r1");
  chk("sin dato → 60", cadenciaEfectiva(null) === 60 && cadenciaEfectiva(0) === 60);
  chk("más fino que el tick no se puede: 5 → 10", cadenciaEfectiva(5) === 10);
  chk("espera 0 → recuerda en cuanto cierra", plan({ esperaMin: 0, ahoraMs: T + MIN }).codigo === "recordar");
}

// ── 5. Sin hora de fin: se recuerda igual, sin escalar ──────────────────────────────────
{
  const p = plan({ servicios: [srv({ finMs: null })] });
  chk("ningún servicio con hora → recuerda por turnos del reloj", p.codigo === "recordar" && p.turno?.startsWith("h") === true && p.ronda === null);
  chk("…y no escala (no se sabe cuántos lleva)", !escalaAlDirectorio(p.ronda));
}

// ── 6. Escalar al directorio tras N recordatorios ───────────────────────────────────────
{
  chk(`no escala en los primeros ${ESCALAR_TRAS_RECORDATORIOS - 1}`, !escalaAlDirectorio(0) && !escalaAlDirectorio(ESCALAR_TRAS_RECORDATORIOS - 2));
  chk(`escala desde el ${ESCALAR_TRAS_RECORDATORIOS}.º`, escalaAlDirectorio(ESCALAR_TRAS_RECORDATORIOS - 1) && escalaAlDirectorio(10));
}

// ── 7. Barrido: nunca se recuerda a quien ya cumplió, y sí a quien no ───────────────────
{
  let malos = 0, recordados = 0;
  for (const checkout of [false, true])
    for (const lect of [null, "antes", "despues", "anulada", "otra"] as const)
      for (const mins of [-30, 0, 4, 6, 59, 61, 125, 400])
        for (const estados of [["finalizada"], ["finalizada", "cancelada"], ["finalizada", "en_curso"]]) {
          const lecturas: LecturaCheckout[] = lect == null ? [] : [{
            vehiculo: lect === "otra" ? "propio:9" : "propio:7",
            ts: lect === "antes" ? T - 5 * 60 * MIN : T + 2 * MIN,
            anulada: lect === "anulada",
          }];
          const p = planRecordarCheckout({
            servicios: estados.map((e) => srv({ estado: e })), checkoutHecho: checkout, lecturas,
            ahoraMs: T + mins * MIN, esperaMin: 5, cadenciaMin: 60,
          });
          const cumplio = checkout || lect === "despues";
          if (p.codigo === "recordar" && cumplio) malos++;
          if (p.codigo === "recordar" && estados.includes("en_curso")) malos++;
          if (p.codigo === "recordar") recordados++;
          const debe = !cumplio && !estados.includes("en_curso") && mins >= 5;
          if (debe && p.codigo !== "recordar") malos++;
        }
  chk("barrido: no se recuerda a quien cumplió ni a quien sigue en ruta, y sí a todo el que falta", malos === 0, `${malos} mal`);
  chk("…y el barrido recuerda de verdad (no es trivial)", recordados > 0, `${recordados}`);
}

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
