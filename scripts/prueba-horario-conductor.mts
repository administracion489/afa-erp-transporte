// Pruebas del HORARIO DE ENVÍO AL CONDUCTOR (lib/alertas-horario.ts) — el módulo que
// decide si un aviso sale ahora o espera a que el conductor esté despierto.
// NO toca la base: todo en memoria, con el reloj pasado por parámetro.
// Uso:  npx tsx scripts/prueba-horario-conductor.mts   (sale con código 1 si algo falla)
//
// EL CASO QUE LO MOTIVÓ, y va dentro como prueba de regresión: los avisos de "vehículo
// asignado" llegaban a las 00:00 (reservas #18368/#18369/#18370, set-2026). No era una
// hora mal configurada: `/api/alertas-flota/tick` consulta `fecha_servicio in (hoy,
// mañana)`, así que un programa fijo creado con antelación se detecta justo cuando su
// fecha pasa a ser "mañana" — a medianoche — y el diff lo lee como "recién asignado".
//
// LA MITAD QUE NO SE PUEDE AFLOJAR tiene su propia sección: un aviso NUNCA se retiene
// más allá del servicio que anuncia. Un WhatsApp a deshora molesta; un bus sin conductor
// no se arregla a la mañana siguiente.

import {
  dentroDeVentana,
  fechaLima,
  hhmmAMinutos,
  horarioDe,
  limaAUtcMs,
  minutoDelDiaLima,
  minutosAHhmm,
  planDeEnvioConductor,
  proximaAperturaMs,
  type Horario,
} from "../lib/alertas-horario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

/** Instante en hora de Lima, para que las pruebas se lean como se leería un reloj. */
const lima = (fecha: string, hora: string) => limaAUtcMs(fecha, hora)!;

/** La ventana que siembra supabase/alertas-horario-conductor.sql. */
const VENTANA: Horario = { respeta: true, desdeMin: 12 * 60, hastaMin: 22 * 60 };

// ── 1. Aritmética de Lima (UTC-5 fijo) ─────────────────────────────────────────
{
  chk("hhmmAMinutos entiende una hora", hhmmAMinutos("12:00") === 720, String(hhmmAMinutos("12:00")));
  chk("y los segundos sobrantes no estorban", hhmmAMinutos("06:30:00") === 390, String(hhmmAMinutos("06:30:00")));
  chk("una hora imposible es null", hhmmAMinutos("99:99") === null && hhmmAMinutos("25:00") === null);
  chk("vacío es null", hhmmAMinutos("") === null && hhmmAMinutos(null) === null);
  chk("ida y vuelta", minutosAHhmm(hhmmAMinutos("07:05")!) === "07:05");

  // 05:00 UTC = medianoche en Lima: el minuto en que entraba el aviso del bug.
  chk("05:00 UTC es medianoche en Lima", minutoDelDiaLima(Date.UTC(2026, 8, 14, 5, 0)) === 0);
  chk("y sigue siendo el día anterior a las 04:59 UTC",
    fechaLima(Date.UTC(2026, 8, 14, 4, 59)) === "2026-09-13", fechaLima(Date.UTC(2026, 8, 14, 4, 59)));
  chk("limaAUtcMs y fechaLima cierran el ciclo",
    fechaLima(lima("2026-09-14", "23:30")) === "2026-09-14");
}

// ── 2. La ventana ──────────────────────────────────────────────────────────────
{
  chk("el borde de apertura está DENTRO", dentroDeVentana(720, 720, 1320));
  chk("el de cierre está FUERA", !dentroDeVentana(1320, 720, 1320));
  chk("la medianoche está fuera de 12:00–22:00", !dentroDeVentana(0, 720, 1320));

  // Nada impide configurar una ventana nocturna desde el panel, y una ventana mal
  // interpretada retendría mensajes para siempre.
  chk("una ventana que cruza medianoche incluye la madrugada", dentroDeVentana(60, 1320, 360));
  chk("…y excluye la tarde", !dentroDeVentana(900, 1320, 360));

  chk("la próxima apertura de hoy si aún no llegó",
    proximaAperturaMs(lima("2026-09-14", "03:00"), 720) === lima("2026-09-14", "12:00"));
  chk("y la de mañana si ya pasó",
    proximaAperturaMs(lima("2026-09-14", "23:00"), 720) === lima("2026-09-15", "12:00"));
}

// ── 3. EL BUG REPORTADO: el aviso de medianoche ────────────────────────────────
{
  // 00:05 del 14. El servicio es el 15 a las 06:00 — la reserva acaba de entrar a la
  // ventana `fecha_servicio in (hoy, mañana)` del motor, y por eso se detecta ahora.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "00:05"),
    fechaServicio: "2026-09-15", horaServicio: "06:00", horario: VENTANA,
  });
  chk("a las 00:05 el aviso de mañana ESPERA", p.enviar === false, p.codigo);
  chk("…y espera hasta el mediodía de HOY",
    p.enviar === false && p.abreMs === lima("2026-09-14", "12:00"),
    p.enviar === false ? p.abreTexto : "salió");

  // El mismo aviso, ya en la ventana: sale.
  const q = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "12:00"),
    fechaServicio: "2026-09-15", horaServicio: "06:00", horario: VENTANA,
  });
  chk("a las 12:00 en punto sale", q.enviar === true && q.codigo === "en_ventana", q.codigo);
}
{
  // Un operador que asigna a media tarde no espera nada: es el caso normal y el que no
  // se puede degradar por arreglar el de medianoche.
  for (const hora of ["12:00", "15:30", "21:59"]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", hora),
      fechaServicio: "2026-09-16", horaServicio: "06:00", horario: VENTANA,
    });
    chk(`asignar a las ${hora} sale al instante`, p.enviar === true && p.codigo === "en_ventana", p.codigo);
  }
}

// ── 4. LO QUE NUNCA SE RETIENE (la mitad que importa) ──────────────────────────
{
  // LA REGLA DURA: la ventana abriría DESPUÉS de la salida del bus. Esperar sería no
  // avisar. Se asigna a las 23:00 un servicio de mañana a las 06:00.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-15", horaServicio: "06:00", horario: VENTANA,
  });
  chk("si la ventana abre después del servicio, sale YA", p.enviar === true && p.codigo === "no_alcanza", p.codigo);

  // Justo al otro lado de la frontera: el servicio es a las 12:01, un minuto después de
  // que abra la ventana → todavía alcanza, así que espera.
  const justo = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-15", horaServicio: "12:01", horario: VENTANA,
  });
  chk("un minuto después de la apertura sí espera", justo.enviar === false, justo.codigo);
  const empate = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-15", horaServicio: "12:00", horario: VENTANA,
  });
  chk("a la hora exacta de la apertura NO espera (llegaría tarde)",
    empate.enviar === true && empate.codigo === "no_alcanza", empate.codigo);
}
{
  // Un cambio de HOY sobre un servicio de HOY es un hecho real y urgente, no el
  // artefacto de medianoche: sale a la hora que sea.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"),
    fechaServicio: "2026-09-14", horaServicio: "20:00", horario: VENTANA,
  });
  chk("un servicio de HOY se avisa al instante", p.enviar === true && p.codigo === "servicio_hoy", p.codigo);
}
{
  // Sin saber QUÉ DÍA es el servicio no se puede comprobar la regla dura → se envía.
  // Molestar es reversible; dejar un bus sin conductor no.
  for (const fecha of [null, "", undefined]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", "03:00"), fechaServicio: fecha, horaServicio: "06:00", horario: VENTANA,
    });
    chk(`sin fecha (${String(fecha)}) el aviso sale`, p.enviar === true && p.codigo === "sin_fecha", p.codigo);
  }
  // SIN HORA es otra cosa y no se envía a ciegas: el servicio se sitúa a las 00:00 de su
  // día, el inicio más temprano que puede tener. Suponer temprano solo puede adelantar el
  // envío (regla dura), nunca retenerlo de más — que es el lado seguro del error.
  const sinHora = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"),
    fechaServicio: "2026-09-15", horaServicio: null, horario: VENTANA,
  });
  chk("sin hora se supone el inicio más temprano y se retiene al mediodía",
    sinHora.enviar === false && sinHora.abreMs === lima("2026-09-14", "12:00"), sinHora.codigo);
  const sinHoraTarde = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-15", horaServicio: null, horario: VENTANA,
  });
  chk("…y de noche sale ya, porque las 00:00 supuestas no alcanzan",
    sinHoraTarde.enviar === true && sinHoraTarde.codigo === "no_alcanza", sinHoraTarde.codigo);
  // Una fecha PASADA nunca retiene: la ventana ya no llega a tiempo por definición.
  const viejo = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"),
    fechaServicio: "2026-09-10", horaServicio: "06:00", horario: VENTANA,
  });
  chk("un servicio ya pasado no se retiene", viejo.enviar === true, viejo.codigo);
}

// ── 5. El interruptor por tipo, y el deploy sin migración ──────────────────────
{
  // `proximo_inicio` (90 min) y `recuerda_iniciar` (30 min) son urgentes POR DISEÑO:
  // retenerlos sería exactamente el daño. Se declara, no se deduce de la clave.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "00:05"),
    fechaServicio: "2026-09-15", horaServicio: "06:00",
    horario: { respeta: false, desdeMin: 720, hastaMin: 1320 },
  });
  chk("un tipo que no respeta horario sale siempre", p.enviar === true && p.codigo === "no_difiere", p.codigo);
}
{
  // REGLA DE ORO DE LOS DEFAULTS: sin la migración corrida las columnas llegan
  // undefined y el comportamiento tiene que ser el de ANTES — enviar al instante.
  const sinMigrar = horarioDe({});
  chk("sin migración, no se respeta ningún horario", sinMigrar.respeta === false);
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "00:05"),
    fechaServicio: "2026-09-15", horaServicio: "06:00", horario: sinMigrar,
  });
  chk("y el aviso de medianoche sale, exactamente como hoy",
    p.enviar === true && p.codigo === "no_difiere", p.codigo);

  chk("horarioDe lee la fila sembrada",
    JSON.stringify(horarioDe({ respeta_horario: true, horario_desde: "12:00", horario_hasta: "22:00" }))
      === JSON.stringify(VENTANA));
  chk("un null explícito tampoco respeta horario", horarioDe({ respeta_horario: null }).respeta === false);
}
{
  // Una ventana a medio configurar no puede silenciar el sistema: se envía.
  for (const horario of [
    { respeta: true, desdeMin: null, hastaMin: 1320 },
    { respeta: true, desdeMin: 720, hastaMin: null },
    { respeta: true, desdeMin: 720, hastaMin: 720 },   // longitud cero
  ] as Horario[]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", "00:05"),
      fechaServicio: "2026-09-15", horaServicio: "06:00", horario,
    });
    chk(`ventana incompleta (${horario.desdeMin}→${horario.hastaMin}) no retiene`,
      p.enviar === true && p.codigo === "sin_ventana", p.codigo);
  }
}

// ── 6. Invariante por barrido: NUNCA se retiene más allá del servicio ──────────
{
  // La única garantía que no puede fallar en ninguna combinación. Se barre el día
  // entero (cada 10 min, la cadencia real del tick) contra servicios de hoy, mañana y
  // pasado mañana a toda hora, con dos ventanas: la sembrada y una nocturna.
  const ventanas: Horario[] = [
    { respeta: true, desdeMin: 720, hastaMin: 1320 },
    { respeta: true, desdeMin: 1320, hastaMin: 360 },  // 22:00 → 06:00
  ];
  let casos = 0, tardios = 0, retenidos = 0;
  for (const horario of ventanas) {
    for (let min = 0; min < 1440; min += 10) {
      const ahoraMs = lima("2026-09-14", minutosAHhmm(min));
      for (const fecha of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
        for (let h = 0; h < 24; h++) {
          const horaServicio = minutosAHhmm(h * 60);
          const p = planDeEnvioConductor({ ahoraMs, fechaServicio: fecha, horaServicio, horario });
          casos++;
          if (p.enviar) continue;
          retenidos++;
          const inicio = limaAUtcMs(fecha, horaServicio)!;
          if (p.abreMs >= inicio) tardios++;
        }
      }
    }
  }
  chk(`ninguna espera alcanza al servicio (${casos} combinaciones, ${retenidos} retenidas)`,
    tardios === 0, `${tardios} tardía(s)`);
  // Si esto llega a 0, el módulo dejó de hacer su trabajo y la prueba de arriba
  // pasaría igual: un "no retiene nunca" cumple la invariante de forma trivial.
  chk("…y sí retiene de verdad en la madrugada", retenidos > 0, String(retenidos));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
