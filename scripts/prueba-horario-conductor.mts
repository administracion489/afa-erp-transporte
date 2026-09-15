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
  textoDuracion,
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
const VENTANA: Horario = { respeta: true, desdeMin: 12 * 60, hastaMin: 22 * 60, margenMin: 90 };

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

// ── 4. LA REGLA DURA: se retiene mientras el horario llegue A TIEMPO ───────────
{
  // LOS TRES CASOS REALES DEL DUEÑO, con SU ventana (11:59–21:00) y el margen heredado.
  // Los tres se programan de noche, fuera del horario; lo único que cambia es a qué hora
  // es el servicio, y eso es exactamente lo que tiene que decidir.
  const suya: Horario = { respeta: true, desdeMin: 11 * 60 + 59, hastaMin: 21 * 60, margenMin: 90 };
  const alAbrir = (ahora: string, hora: string) => planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", ahora), fechaServicio: "2026-09-15", horaServicio: hora, horario: suya,
  });

  const tarde = alAbrir("23:00", "15:00");
  chk("23:00 → servicio de mañana a las 15:00: ESPERA, no lo despierta",
    tarde.enviar === false && tarde.abreMs === lima("2026-09-15", "11:59"),
    tarde.enviar === false ? tarde.abreTexto : tarde.codigo);

  const madrugada = alAbrir("21:01", "03:00");
  chk("21:01 → servicio de mañana a las 03:00: URGENTE, sale ya",
    madrugada.enviar === true && madrugada.codigo === "urgente", madrugada.codigo);

  const filo = alAbrir("21:01", "12:00");
  chk("21:01 → servicio de mañana a las 12:00: URGENTE (llegaría con 1 min)",
    filo.enviar === true && filo.codigo === "urgente", filo.codigo);

  // LA FRONTERA EXACTA del margen. La apertura es a las 11:59: con el servicio a las
  // 13:29 faltan 90 min justos (espera) y un minuto antes, 89 (urgente).
  chk("a 90 min justos de la apertura todavía espera", alAbrir("23:00", "13:29").enviar === false);
  chk("a 89 min ya es urgente", alAbrir("23:00", "13:28").enviar === true);
}
{
  // EL BUG ORIGINAL SIGUE CERRADO: el programa fijo que se detecta a medianoche.
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-15", "00:05"),
    fechaServicio: "2026-09-16", horaServicio: "06:00", horario: VENTANA,
  });
  chk("el aviso de medianoche para pasado mañana sigue esperando al mediodía",
    p.enviar === false && p.abreMs === lima("2026-09-15", "12:00"),
    p.enviar === false ? p.abreTexto : p.codigo);
}
{
  // Y SE FUE LA EXCEPCIÓN «servicio de HOY», que era demasiado ancha: despertaba a las
  // 03:00 por un servicio de las 15:00 del mismo día. Ahora decide el margen.
  const lejos = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"),
    fechaServicio: "2026-09-14", horaServicio: "15:00", horario: VENTANA,
  });
  chk("un servicio de HOY a las 15:00 detectado a las 03:00 ya NO lo despierta",
    lejos.enviar === false, lejos.codigo);
  const cerca = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"),
    fechaServicio: "2026-09-14", horaServicio: "05:00", horario: VENTANA,
  });
  chk("…pero uno de HOY a las 05:00 sí sale al instante",
    cerca.enviar === true && cerca.codigo === "urgente", cerca.codigo);
}
{
  // Margen 0 = "nada es urgente": todo lo que caiga fuera del horario espera.
  const sinMargen: Horario = { respeta: true, desdeMin: 720, hastaMin: 1320, margenMin: 0 };
  const p = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"),
    fechaServicio: "2026-09-15", horaServicio: "12:30", horario: sinMargen,
  });
  chk("con margen 0 hasta un servicio de las 12:30 espera", p.enviar === false, p.codigo);
  chk("un 0 explícito se respeta y no cae al defecto",
    horarioDe({ respeta_horario: true, horario_desde: "12:00", horario_hasta: "22:00", horario_margen_min: 0 }).margenMin === 0);
  chk("y sin columna se usan los 90 heredados",
    horarioDe({ respeta_horario: true, horario_desde: "12:00", horario_hasta: "22:00" }).margenMin === 90);
}
{
  // Sin saber CUÁNDO es el servicio no se puede comprobar la regla dura → se envía.
  for (const fecha of [null, "", undefined]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", "03:00"), fechaServicio: fecha, horaServicio: "06:00", horario: VENTANA,
    });
    chk(`sin fecha (${String(fecha)}) el aviso sale`, p.enviar === true && p.codigo === "sin_fecha", p.codigo);
  }
  // Sin hora se supone el inicio más temprano (00:00), el lado seguro.
  const sinHora = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "23:00"), fechaServicio: "2026-09-15", horario: VENTANA,
  });
  chk("sin hora se supone lo más temprano y sale", sinHora.enviar === true && sinHora.codigo === "urgente", sinHora.codigo);
  // Una fecha PASADA nunca retiene.
  const viejo = planDeEnvioConductor({
    ahoraMs: lima("2026-09-14", "03:00"), fechaServicio: "2026-09-10", horaServicio: "06:00", horario: VENTANA,
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
    horario: { respeta: false, desdeMin: 720, hastaMin: 1320, margenMin: 90 },
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
    { respeta: true, desdeMin: null, hastaMin: 1320, margenMin: 90 },
    { respeta: true, desdeMin: 720, hastaMin: null, margenMin: 90 },
    { respeta: true, desdeMin: 720, hastaMin: 720, margenMin: 90 },   // longitud cero
  ] as Horario[]) {
    const p = planDeEnvioConductor({
      ahoraMs: lima("2026-09-14", "00:05"),
      fechaServicio: "2026-09-15", horario,
    });
    chk(`ventana incompleta (${horario.desdeMin}→${horario.hastaMin}) no retiene`,
      p.enviar === true && p.codigo === "sin_ventana", p.codigo);
  }
}

// ── 6. Invariante por barrido: ninguna espera avisa tarde ─────────────────────
{
  // Lo que no puede fallar en ninguna combinación: si se retiene, al abrir el horario
  // todavía queda AL MENOS el margen antes del servicio. Se barre el día entero cada
  // 10 min (la cadencia real del tick) contra servicios de hoy, mañana y pasado mañana a
  // toda hora, con cuatro ventanas —incluida la real del dueño— y tres márgenes.
  const ventanas: [number, number][] = [
    [720, 1320],            // 12:00–22:00, la sembrada
    [7 * 60, 21 * 60],      // 07:00–21:00
    [11 * 60 + 59, 21 * 60],// 11:59–21:00, la suya
    [1320, 360],            // 22:00–06:00, nocturna
  ];
  let casos = 0, tardios = 0, retenidos = 0;
  for (const [desdeMin, hastaMin] of ventanas) {
    for (const margenMin of [0, 90, 240]) {
      const horario: Horario = { respeta: true, desdeMin, hastaMin, margenMin };
      for (let min = 0; min < 1440; min += 10) {
        const ahoraMs = lima("2026-09-14", minutosAHhmm(min));
        for (const fecha of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
          for (let h = 0; h < 24; h++) {
            const horaServicio = minutosAHhmm(h * 60);
            const p = planDeEnvioConductor({ ahoraMs, fechaServicio: fecha, horaServicio, horario });
            casos++;
            if (p.enviar) continue;
            retenidos++;
            const antelacion = (limaAUtcMs(fecha, horaServicio)! - p.abreMs) / 60_000;
            if (antelacion < margenMin) tardios++;
          }
        }
      }
    }
  }
  chk(`toda espera conserva su margen (${casos} combinaciones, ${retenidos} retenidas)`,
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
  const invertida: Horario = { respeta: true, desdeMin: 21 * 60, hastaMin: 7 * 60, margenMin: 90 };
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
  chk("la frase nombra el margen de urgencia", describirHorario(7 * 60, 21 * 60, 90).includes("1 h 30 min"),
    describirHorario(7 * 60, 21 * 60, 90));
  chk("con margen 0 dice que nada es urgente", describirHorario(7 * 60, 21 * 60, 0).includes("Nada se considera urgente"));
  chk("textoDuracion", textoDuracion(45) === "45 min" && textoDuracion(90) === "1 h 30 min" && textoDuracion(120) === "2 h");
  chk("una ventana vacía se describe como apagada",
    describirHorario(9 * 60, 9 * 60).includes("al instante"));
  chk("y una incompleta también", describirHorario(null, 21 * 60).includes("al instante"));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
