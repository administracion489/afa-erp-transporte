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
  describirHorario,
  fechaLima,
  hhmmAMinutos,
  horarioDe,
  limaAUtcMs,
  minutoDelDiaLima,
  minutosAHhmm,
  planDeEnvioConductor,
  proximaAperturaMs,
  ventanaCubreMadrugada,
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
    fechaServicio: "2026-09-15", horario: VENTANA,
  });
  chk("a las 00:05 el aviso de mañana ESPERA", p.enviar === false, p.codigo);
  chk("…y espera hasta el mediodía de HOY",
    p.enviar === false && p.abreMs === lima("2026-09-14", "12:00"),
    p.enviar === false ? p.abreTexto : "salió");

  // El mismo aviso, ya en la ventana: sale.
  const q = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "12:00"),
    fechaServicio: "2026-09-15", horario: VENTANA,
  });
  chk("a las 12:00 en punto sale", q.enviar === true && q.codigo === "en_ventana", q.codigo);
}
{
  // Un operador que asigna a media tarde no espera nada: es el caso normal y el que no
  // se puede degradar por arreglar el de medianoche.
  for (const hora of ["12:00", "15:30", "21:59"]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", hora),
      fechaServicio: "2026-09-16", horario: VENTANA,
    });
    chk(`asignar a las ${hora} sale al instante`, p.enviar === true && p.codigo === "en_ventana", p.codigo);
  }
}

// ── 4. LO QUE NUNCA SE RETIENE (la mitad que importa) ──────────────────────────
{
  // LA REGLA DURA: solo se retiene lo que se va a entregar la VÍSPERA. Se asigna a las
  // 23:00 un servicio de mañana a las 06:00 → la ventana no vuelve a abrir hasta el día
  // del servicio, así que sale ya.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-15", horario: VENTANA,
  });
  chk("si el horario solo abre el día del servicio, sale YA",
    p.enviar === true && p.codigo === "no_es_vispera", p.codigo);

  // Un día más allá sí alcanza a ser víspera.
  const pasado = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-16", horario: VENTANA,
  });
  chk("para un servicio de pasado mañana sí espera", pasado.enviar === false, pasado.codigo);
  chk("…y lo entrega la víspera",
    pasado.enviar === false && pasado.abreMs === lima("2026-09-15", "12:00"),
    pasado.enviar === false ? pasado.abreTexto : "salió");
}
{
  // EL CASO QUE REPORTÓ EL DUEÑO — «el servicio urgente que se programa a las 21:01 de
  // hoy y arranca a las 03:00 de mañana». Con su ventana real (11:59–21:00).
  const suya: Horario = { respeta: true, desdeMin: 11 * 60 + 59, hastaMin: 21 * 60 };
  for (const hora of ["03:00", "06:00", "11:30", "12:00", "14:00", "23:59"]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", "21:01"), fechaServicio: "2026-09-15", horario: suya,
    });
    chk(`urgente 21:01 → servicio del 15 a las ${hora}: sale al instante`,
      p.enviar === true && p.codigo === "no_es_vispera", p.codigo);
  }
  // EL AGUJERO QUE DESTAPÓ, conservado como regresión: con la regla vieja («no retener
  // más allá de la HORA»), un servicio del 15 a las 12:00 se retenía hasta las 11:59 y
  // le llegaba con UN MINUTO de aviso, porque 11:59 es técnicamente "antes" de las 12:00.
  const aperturaVieja = lima("2026-09-15", "11:59");
  chk("la regla vieja habría dado 1 minuto de aviso (por eso ya no se mira la hora)",
    aperturaVieja < lima("2026-09-15", "12:00") && aperturaVieja > lima("2026-09-15", "11:00"));
  // Y el de PASADO mañana sigue esperando: el urgente no puede desactivar el arreglo.
  const lejano = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "21:01"), fechaServicio: "2026-09-16", horario: suya,
  });
  chk("…pero el del 16 sigue esperando al mediodía del 15",
    lejano.enviar === false && lejano.abreMs === lima("2026-09-15", "11:59"),
    lejano.enviar === false ? lejano.abreTexto : "salió");
}
{
  // Un cambio de HOY sobre un servicio de HOY es un hecho real y urgente, no el
  // artefacto de medianoche: sale a la hora que sea.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"), fechaServicio: "2026-09-14", horario: VENTANA,
  });
  chk("un servicio de HOY se avisa al instante", p.enviar === true && p.codigo === "servicio_hoy", p.codigo);
}
{
  // Sin saber QUÉ DÍA es el servicio no se puede comprobar la regla dura → se envía.
  for (const fecha of [null, "", undefined]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", "03:00"), fechaServicio: fecha, horario: VENTANA,
    });
    chk(`sin fecha (${String(fecha)}) el aviso sale`, p.enviar === true && p.codigo === "sin_fecha", p.codigo);
  }
  // Una fecha PASADA nunca retiene: ninguna apertura futura es su víspera.
  const viejo = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"), fechaServicio: "2026-09-10", horario: VENTANA,
  });
  chk("un servicio ya pasado no se retiene", viejo.enviar === true, viejo.codigo);
}

// ── 5. El interruptor por tipo, y el deploy sin migración ──────────────────────
{
  // `proximo_inicio` (90 min) y `recuerda_iniciar` (30 min) son urgentes POR DISEÑO:
  // retenerlos sería exactamente el daño. Se declara, no se deduce de la clave.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "00:05"),
    fechaServicio: "2026-09-15",
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
    fechaServicio: "2026-09-15", horario: sinMigrar,
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
      fechaServicio: "2026-09-15", horario,
    });
    chk(`ventana incompleta (${horario.desdeMin}→${horario.hastaMin}) no retiene`,
      p.enviar === true && p.codigo === "sin_ventana", p.codigo);
  }
}

// ── 6. Invariante por barrido: TODA espera se entrega la VÍSPERA ───────────────
{
  // La única garantía que no puede fallar en ninguna combinación, y es más fuerte que la
  // anterior («no más allá de la hora»): un aviso retenido se entrega en una FECHA
  // anterior a la del servicio, así que ninguna hora puede alcanzarlo — ni las 00:00.
  // Se barre el día entero cada 10 min (la cadencia real del tick) contra servicios de
  // hoy, mañana y pasado mañana, con cuatro ventanas, incluida la real del dueño.
  const ventanas: Horario[] = [
    { respeta: true, desdeMin: 720, hastaMin: 1320 },            // 12:00–22:00, la sembrada
    { respeta: true, desdeMin: 7 * 60, hastaMin: 21 * 60 },      // 07:00–21:00
    { respeta: true, desdeMin: 11 * 60 + 59, hastaMin: 21 * 60 },// 11:59–21:00, la suya
    { respeta: true, desdeMin: 1320, hastaMin: 360 },            // 22:00–06:00, nocturna
  ];
  let casos = 0, tardios = 0, retenidos = 0;
  for (const horario of ventanas) {
    for (let min = 0; min < 1440; min += 10) {
      const ahoraMs = lima("2026-09-14", minutosAHhmm(min));
      for (const fecha of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
        const p = planDeEnvioConductor({ ahoraMs, fechaServicio: fecha, horario });
        casos++;
        if (p.enviar) continue;
        retenidos++;
        if (fechaLima(p.abreMs) >= fecha) tardios++;
      }
    }
  }
  chk(`toda espera se entrega antes del día del servicio (${casos} combinaciones, ${retenidos} retenidas)`,
    tardios === 0, `${tardios} tardía(s)`);
  // Si esto llega a 0, el módulo dejó de hacer su trabajo y la prueba de arriba
  // pasaría igual: un "no retiene nunca" cumple la invariante de forma trivial.
  chk("…y sí retiene de verdad en la madrugada", retenidos > 0, String(retenidos));
}

// ── 7. LA VENTANA INVERTIDA: el error que costó una configuración en producción ──
{
  // El dueño puso 21:00–07:00 leyendo la etiqueta vieja («No escribir de madrugada DE…
  // A…»), que nombraba las horas de SILENCIO mientras los campos son las de ENVÍO. Con
  // eso el aviso seguía saliendo a las 00:05 y encima uno hecho al mediodía esperaba
  // hasta la noche. El motor no puede detectarlo —una ventana nocturna es legítima— así
  // que lo único que queda es que la pantalla lo DIGA antes de guardar.
  const invertida: Horario = { respeta: true, desdeMin: 21 * 60, hastaMin: 7 * 60 };
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-15", "00:05"),
    fechaServicio: "2026-09-16", horario: invertida,
  });
  chk("con 21:00–07:00 el aviso de medianoche SIGUE saliendo (el bug reportado)",
    p.enviar === true && p.codigo === "en_ventana", p.codigo);
  const mediodia = planDeEnvioConductor({
    ahoraMs: lima("2026-09-15", "12:00"),
    fechaServicio: "2026-09-16", horario: invertida,
  });
  chk("…y el de mediodía se retiene hasta la noche, que es lo contrario de lo que se quería",
    mediodia.enviar === false, mediodia.codigo);

  chk("la pantalla AVISA de esa ventana", ventanaCubreMadrugada(21 * 60, 7 * 60));
  chk("y no avisa de la correcta", !ventanaCubreMadrugada(7 * 60, 21 * 60));
  chk("la sembrada tampoco", !ventanaCubreMadrugada(12 * 60, 22 * 60));
  // Una ventana que abarca el día entero salvo un rato SÍ deja escribir de madrugada.
  chk("una ventana casi completa avisa igual", ventanaCubreMadrugada(6 * 60, 5 * 60));
  chk("una ventana a medio configurar no avisa de nada",
    !ventanaCubreMadrugada(null, 7 * 60) && !ventanaCubreMadrugada(9 * 60, 9 * 60));
}
{
  // La frase dice la DIRECCIÓN, que es justo lo que la etiqueta vieja decía al revés.
  const f = describirHorario(7 * 60, 21 * 60);
  chk("la frase nombra el rango de ENVÍO", f.includes("ENVÍA") && f.includes("07:00") && f.includes("21:00"), f);
  chk("y dice hasta cuándo espera lo que cae fuera", f.includes("espera a las 07:00"));
  chk("una ventana vacía se describe como apagada",
    describirHorario(9 * 60, 9 * 60).includes("al instante"));
  chk("y una incompleta también", describirHorario(null, 21 * 60).includes("al instante"));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
