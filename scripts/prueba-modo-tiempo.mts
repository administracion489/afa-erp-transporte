// Pruebas de QUÉ MODO APLICA A QUÉ AVISO (lib/alertas-modo-tiempo.ts) — el módulo que
// contesta si el selector "Cuándo" de cada tarjeta lo lee alguien, y qué pasa cuando el
// modo elegido no es uno de los que su bloque sabe ejecutar.
// NO toca la base: todo en memoria, con el reloj pasado por parámetro.
// Uso:  npx tsx scripts/prueba-modo-tiempo.mts   (sale con código 1 si algo falla)
//
// LOS CUATRO CASOS REALES VAN DENTRO COMO REGRESIÓN. Buscando por qué le llegaban avisos
// al conductor a las 00:00 aparecieron cuatro alertas más mal configuradas desde el panel
// (set-2026), y ninguna era un fallo del motor: `recordatorio_pasajero` avisando a las
// 03:30, y `doc_vence`/`solape`/`jornada` saliendo a las 00:00 por haberse quedado sin
// ventana. Si algún día dejan de reproducirse aquí, el escenario dejó de ser el que se
// rompió.
//
// LA SECCIÓN QUE MANDA es la 5: los dos predicados que gobiernan CADA envío del tick se
// EXTRAJERON, no se reescribieron, así que la versión original va copiada literal y se
// exige resultado idéntico sobre un barrido completo. Mismo contrato que
// `scripts/prueba-costeo.mts` con `lib/costeo-propio.ts`: si eso falla, el motor cambió.

import {
  MODOS_QUE_APLICAN,
  VENTANA_HORA_FIJA_MIN,
  VIA_DE_ALERTA,
  cotejarModoTiempo,
  enViaRecordatorio,
  enVentanaHoraFija,
  etiquetaModo,
  leeElModo,
  viaDeAlerta,
  type ModoTiempo,
} from "../lib/alertas-modo-tiempo";
import { limaAUtcMs } from "../lib/alertas-horario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const MODOS: ModoTiempo[] = ["evento", "anticipacion", "hora_fija"];

// ── 1. LOS CUATRO CASOS REALES (regresión) ─────────────────────────────────────
{
  console.log("\n— Las cuatro alertas mal configuradas que aparecieron en producción —");

  // doc_vence / solape / jornada: barridos diarios que se quedaron SIN ventana.
  for (const [clave, modo, hora] of [
    ["doc_vence", "anticipacion", "08:00"],
    ["solape", "anticipacion", "07:00"],
    ["jornada", "evento", "08:00"],
  ] as const) {
    const m = cotejarModoTiempo({ clave, modo_tiempo: modo, hora_fija: hora });
    chk(`${clave} (${modo} + ${hora}) se denuncia como sin ventana`, m.codigo === "sin_ventana" && m.alarma, m.codigo);
    chk(`  …y el texto NOMBRA la hora que no se está leyendo`, m.detalle.includes(hora) && m.arreglo.includes(hora), m.arreglo);
    chk(`  …y el motor confirma que sale en el primer tick del día`,
      enVentanaHoraFija({ modo_tiempo: modo, hora_fija: hora, ahoraMin: 5 }) === true);
  }

  // recordatorio_pasajero: el modo SÍ aplica — lo que estaba mal era el número, no el modo.
  // El guard no puede inventarse un juicio sobre eso, y no lo hace.
  const rp = cotejarModoTiempo({ clave: "recordatorio_pasajero", modo_tiempo: "anticipacion", min_anticipacion: 90 });
  chk("recordatorio_pasajero en anticipacion NO levanta alarma (el modo es legítimo)",
    rp.codigo === "ok" && !rp.alarma, rp.codigo);

  // Y la configuración que el dueño dejó puesta: los tres a hora fija.
  for (const clave of ["doc_vence", "solape", "jornada"]) {
    const m = cotejarModoTiempo({ clave, modo_tiempo: "hora_fija", hora_fija: "08:00" });
    chk(`${clave} corregido a hora_fija queda limpio`, m.codigo === "ok" && !m.alarma, m.codigo);
  }
  chk("y su ventana vuelve: a las 00:05 NO sale, a las 08:30 sí",
    enVentanaHoraFija({ modo_tiempo: "hora_fija", hora_fija: "08:00", ahoraMin: 5 }) === false &&
    enVentanaHoraFija({ modo_tiempo: "hora_fija", hora_fija: "08:00", ahoraMin: 8 * 60 + 30 }) === true);
}

// ── 2. LA OTRA MITAD: `evento` en un recordatorio no envía NUNCA ───────────────
{
  console.log("\n— Activa y muda: el modo que el bloque de recordatorios no sabe disparar —");
  const claves = Object.entries(VIA_DE_ALERTA).filter(([, v]) => v === "recordatorio").map(([k]) => k);
  chk("hay seis avisos por la vía recordatorio", claves.length === 6, claves.join(", "));
  for (const clave of claves) {
    const m = cotejarModoTiempo({ clave, modo_tiempo: "evento" });
    chk(`${clave} en 'evento' se denuncia como mudo`, m.codigo === "evento_mudo" && m.alarma, m.codigo);
  }
  // Y el motor lo confirma: con `evento` no hay instante del año en que dispare.
  let disparoAlguna = false;
  for (let min = 0; min < 1440; min += 7) {
    const ms = limaAUtcMs("2026-09-15", `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`)!;
    for (const fecha of ["2026-09-15", "2026-09-16", "2026-09-20"]) {
      if (enViaRecordatorio({
        modo_tiempo: "evento", hora_fija: "08:00", min_anticipacion: 90,
        fechaServicio: fecha, horaServicio: "06:00",
        hoy: "2026-09-15", manana: "2026-09-16", ahoraMin: min, ahoraMs: ms,
      })) disparoAlguna = true;
    }
  }
  chk("con 'evento' el bloque de recordatorios NO dispara en ningún minuto del día", !disparoAlguna);
}

// ── 3. Los doce que NO leen el modo ────────────────────────────────────────────
{
  console.log("\n— Doce avisos tienen su propio disparador: su selector no lo lee nadie —");
  const inertes = Object.entries(VIA_DE_ALERTA).filter(([, v]) => v === "ignora_modo").map(([k]) => k);
  chk("son doce", inertes.length === 12, `${inertes.length}: ${inertes.join(", ")}`);
  chk("los cuatro de ciclo de vida están entre ellos",
    ["asignacion", "desasignacion", "cambio", "cancelacion"].every((k) => inertes.includes(k)));
  for (const clave of inertes) {
    chk(`${clave}: el selector NO se ofrece`, !leeElModo(clave));
    for (const modo of MODOS) {
      const m = cotejarModoTiempo({ clave, modo_tiempo: modo, hora_fija: "08:00" });
      chk(`  ${clave}/${modo}: se explica sin alarma`, m.codigo === "modo_inerte" && !m.alarma && !!m.detalle, m.codigo);
    }
  }
  chk("los que SÍ lo leen siguen ofreciéndolo",
    ["recordatorio_conductor", "proximo_inicio", "doc_vence", "solape"].every((k) => leeElModo(k)));
}

// ── 4. Una clave desconocida no se juzga y no se le esconde nada ───────────────
{
  console.log("\n— Lo que el módulo no conoce, no lo afirma —");
  const m = cotejarModoTiempo({ clave: "una_alerta_que_no_existe_todavia", modo_tiempo: "evento" });
  chk("código sin_via", m.codigo === "sin_via");
  chk("sin alarma y sin texto", !m.alarma && !m.detalle && !m.arreglo);
  chk("y el selector se sigue ofreciendo (el lado seguro es NO esconder)",
    leeElModo("una_alerta_que_no_existe_todavia"));
  chk("viaDeAlerta devuelve null", viaDeAlerta("una_alerta_que_no_existe_todavia") === null);
  chk("un modo vacío o basura tampoco rompe nada",
    cotejarModoTiempo({ clave: "doc_vence", modo_tiempo: null }).codigo === "sin_ventana" &&
    cotejarModoTiempo({ clave: "recordatorio_conductor", modo_tiempo: "" as any }).codigo === "evento_mudo");
}

// ── 5. LA EXTRACCIÓN: el original, copiado literal, contra el módulo ───────────
// Copia LITERAL de app/api/alertas-flota/tick/route.ts antes de la extracción. No se toca
// ni para mejorarla: existe para que la comparación signifique algo.
{
  const VENTANA_HORA_FIJA = 120;
  const hhmmAMin = (hhmm?: string | null): number | null => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return Number.isFinite(h) ? h * 60 + (m || 0) : null;
  };
  const limaAUtcMsViejo = (fecha?: string | null, horaHHMM?: string | null): number | null => {
    if (!fecha) return null;
    const [y, m, d] = String(fecha).slice(0, 10).split("-").map(Number);
    const [hh, mm] = String(horaHHMM || "00:00").split(":").map(Number);
    if (!y || !m || !d || !Number.isFinite(hh)) return null;
    return Date.UTC(y, m - 1, d, hh + 5, mm || 0);
  };

  const viejoRecordatorio = (
    cfg: any, r: any, hoy: string, manana: string, ahora: number, force: boolean, nowMs: number,
  ): boolean => {
    if (force) return true;
    if (cfg.modo_tiempo === "hora_fija") {
      if (r.fecha_servicio !== manana) return false;
      const hf = hhmmAMin(cfg.hora_fija) ?? 480;
      return ahora >= hf && ahora < hf + VENTANA_HORA_FIJA;
    }
    if (cfg.modo_tiempo === "anticipacion") {
      if (r.fecha_servicio !== hoy && r.fecha_servicio !== manana) return false;
      const inicioMs = limaAUtcMsViejo(r.fecha_servicio, r.hora_servicio);
      if (inicioMs == null) return false;
      const disparoMs = inicioMs - (cfg.min_anticipacion ?? 90) * 60_000;
      return nowMs >= disparoMs && nowMs < inicioMs;
    }
    return false;
  };

  const viejoHoraFija = (cfg: any, ahora: number, force: boolean): boolean => {
    if (force) return true;
    if (cfg.modo_tiempo !== "hora_fija") return true;
    const hf = hhmmAMin(cfg.hora_fija);
    if (hf == null) return true;
    return ahora >= hf && ahora < hf + VENTANA_HORA_FIJA;
  };

  console.log("\n— Extracción: el original copiado literal contra el módulo (barrido) —");
  chk("la ventana es la misma constante", VENTANA_HORA_FIJA === VENTANA_HORA_FIJA_MIN);

  const HOY = "2026-09-15", MANANA = "2026-09-16";
  const HORAS_FIJAS = [null, "", "08:00", "07:00", "00:00", "23:45", "no-es-una-hora", "25:00"];
  const ANTICIPACIONES = [null, 0, 30, 90, 720, 1500];
  const FECHAS = [null, "", HOY, MANANA, "2026-09-14", "2026-09-20"];
  const HORAS_SERVICIO = [null, "00:00", "03:00", "06:00:00", "12:00", "15:30", "23:59"];

  let casos = 0, distintos = 0, primerDiff = "";
  for (const modo of [...MODOS, "" as any, null as any]) {
    for (const hora_fija of HORAS_FIJAS) {
      for (const min_anticipacion of ANTICIPACIONES) {
        for (const fechaServicio of FECHAS) {
          for (const horaServicio of HORAS_SERVICIO) {
            for (const min of [0, 5, 419, 420, 479, 480, 481, 599, 600, 719, 720, 1319, 1439]) {
              for (const force of [false, true]) {
                const hhmm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
                const ahoraMs = limaAUtcMs(HOY, hhmm)!;
                const cfg = { modo_tiempo: modo, hora_fija, min_anticipacion };
                const r = { fecha_servicio: fechaServicio, hora_servicio: horaServicio };

                const a = viejoRecordatorio(cfg, r, HOY, MANANA, min, force, ahoraMs);
                const b = enViaRecordatorio({
                  ...cfg, fechaServicio, horaServicio, hoy: HOY, manana: MANANA, ahoraMin: min, ahoraMs, force,
                });
                const c = viejoHoraFija(cfg, min, force);
                const d = enVentanaHoraFija({ modo_tiempo: modo, hora_fija, ahoraMin: min, force });

                casos++;
                if (a !== b || c !== d) {
                  distintos++;
                  if (!primerDiff) {
                    primerDiff = `modo=${modo} hf=${hora_fija} ant=${min_anticipacion} fecha=${fechaServicio} hora=${horaServicio} min=${min} force=${force} · rec ${a}/${b} · hf ${c}/${d}`;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  chk(`${casos.toLocaleString("es-PE")} combinaciones: el módulo hace EXACTAMENTE lo que hacía el route`,
    distintos === 0, primerDiff);
}

// ── 6. Invariantes del cotejo (barrido sobre toda la tabla) ────────────────────
{
  console.log("\n— Invariantes —");
  const claves = [...Object.keys(VIA_DE_ALERTA), "clave_desconocida"];
  let malAlarma = 0, malTexto = 0, malAplica = 0;
  for (const clave of claves) {
    for (const modo of [...MODOS, "" as any]) {
      for (const hora_fija of [null, "08:00"]) {
        const m = cotejarModoTiempo({ clave, modo_tiempo: modo, hora_fija });
        // (a) Solo pintan ámbar los dos códigos que CAMBIAN lo que hace el sistema.
        if (m.alarma !== (m.codigo === "evento_mudo" || m.codigo === "sin_ventana")) malAlarma++;
        // (b) Toda alarma dice qué pasa Y qué hacer; lo que no alarma no promete nada.
        if (m.alarma && (!m.detalle || !m.arreglo)) malTexto++;
        if (!m.alarma && m.arreglo) malTexto++;
        // (c) `ok` ⟺ el modo está en la lista de su vía.
        const via = viaDeAlerta(clave);
        const aplica = via !== null && (MODOS_QUE_APLICAN[via] as string[]).includes(String(modo));
        if (aplica !== (m.codigo === "ok")) malAplica++;
      }
    }
  }
  chk("alarma ⟺ (evento_mudo ∨ sin_ventana)", malAlarma === 0, `${malAlarma} casos`);
  chk("toda alarma nombra el problema Y el arreglo; lo demás no propone nada", malTexto === 0, `${malTexto} casos`);
  chk("ok ⟺ el modo es uno de los que su vía ejecuta", malAplica === 0, `${malAplica} casos`);
  chk("ninguna clave de la tabla queda sin vía", Object.values(VIA_DE_ALERTA).every((v) => !!v));
  chk("las etiquetas son las del desplegable",
    etiquetaModo("evento") === "Al ocurrir (evento)" &&
    etiquetaModo("anticipacion") === "Antes del servicio" &&
    etiquetaModo("hora_fija") === "A una hora fija");
}

// ── 7. El lado que NO se puede aflojar: lo bien configurado sigue disparando ────
{
  console.log("\n— Lo que funciona tiene que seguir funcionando —");
  // proximo_inicio a 90 min de un servicio de las 06:00 del 16, mirado a las 04:30 del 16.
  const ms = limaAUtcMs("2026-09-16", "04:30")!;
  chk("proximo_inicio (90 min) dispara en su ventana",
    enViaRecordatorio({
      modo_tiempo: "anticipacion", min_anticipacion: 90,
      fechaServicio: "2026-09-16", horaServicio: "06:00",
      hoy: "2026-09-16", manana: "2026-09-17", ahoraMin: 270, ahoraMs: ms,
    }) === true);
  chk("y NO dispara dos horas antes de su ventana",
    enViaRecordatorio({
      modo_tiempo: "anticipacion", min_anticipacion: 90,
      fechaServicio: "2026-09-16", horaServicio: "06:00",
      hoy: "2026-09-16", manana: "2026-09-17", ahoraMin: 150, ahoraMs: limaAUtcMs("2026-09-16", "02:30")!,
    }) === false);
  chk("ni después de la hora de inicio",
    enViaRecordatorio({
      modo_tiempo: "anticipacion", min_anticipacion: 90,
      fechaServicio: "2026-09-16", horaServicio: "06:00",
      hoy: "2026-09-16", manana: "2026-09-17", ahoraMin: 365, ahoraMs: limaAUtcMs("2026-09-16", "06:05")!,
    }) === false);
  // recordatorio_conductor a 720 min (12 h), que es a lo que volvió tras el arreglo.
  chk("recordatorio_conductor (12 h) dispara la víspera a las 18:00 para un servicio de las 06:00",
    enViaRecordatorio({
      modo_tiempo: "anticipacion", min_anticipacion: 720,
      fechaServicio: "2026-09-16", horaServicio: "06:00",
      hoy: "2026-09-15", manana: "2026-09-16", ahoraMin: 18 * 60, ahoraMs: limaAUtcMs("2026-09-15", "18:00")!,
    }) === true);
  chk("?force=1 sigue ignorando toda ventana",
    enViaRecordatorio({
      modo_tiempo: "evento", fechaServicio: null,
      hoy: "2026-09-15", manana: "2026-09-16", ahoraMin: 0, ahoraMs: 0, force: true,
    }) === true &&
    enVentanaHoraFija({ modo_tiempo: "hora_fija", hora_fija: "08:00", ahoraMin: 0, force: true }) === true);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
