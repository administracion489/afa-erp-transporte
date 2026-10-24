// npx tsx scripts/prueba-reserva-orden.mts
// ¿Pedir el pago ya, confirmar la unidad primero o derivar? (lib/traslados/reserva-orden.ts) y los
// minutos de atención (lib/crm-ia-atencion.ts). Barre 4 horarios × 3 P × 3 M × 7 días cada 15 min ×
// servicio de 0 a 72 h, y fija:
//  · pedir_pago ⟺ la regla (elegible ∧ horario en uso ∧ C + M ≤ inicio, con C contado desde la
//    próxima apertura), y derivar ⟺ la próxima apertura ≥ inicio;
//  · el plazo cae SIEMPRE dentro de una ventana de atención;
//  · más tarde «ahora» nunca hace aparecer pedir_pago; un servicio más tarde nunca lo quita;
//  · salen las tres acciones (corolario: un motor que nunca pidiera el pago cumpliría lo demás);
//  · 21:00 con servicio mañana 05:00 → derivar; `zona_sin_envio` nunca da pedir_pago;
//  · `proximaAtencion` nueva ≡ la vieja copiada literal; `sumarMinutosAtencion` ≡ un oráculo que
//    cuenta minuto a minuto;
//  · `frasePlazo` sin idioma (y con «es») ≡ la de 93c594b copiada literal; en inglés, la MISMA hora
//    y el mismo día que en castellano, siempre con «(Lima time)» y sin castellano filtrado.
import {
  aperturaSiguiente, atencionValida, proximaAtencion, sumarMinutosAtencion, ultimoInstanteAtencionAntes, type Atencion,
} from "../lib/crm-ia-atencion";
import {
  MARGEN_DEFECTO_MIN, MOTIVOS_CORRECCION, MOTIVOS_ELEGIBILIDAD, MOTIVOS_TIEMPO, MOTIVO_ORDEN, PLAZO_CONFIRMACION_DEFECTO_MIN,
  confirmarAntesDe, elegibilidadDeReserva, frasePlazo, ordenDeReserva, ordenDeSolicitud, plazosDe, type MotivoOrden,
} from "../lib/traslados/reserva-orden";
import { normalizarConfigReserva, type ConfigReserva } from "../lib/traslados/reserva-pago";
import { diaSemanaLima, sumarDias } from "../lib/comisiones/calendario";
import { horaHHMM } from "../lib/crm-ia-ajustes";
import { hhmmAMinutos, limaAUtcMs, fechaLima, minutoDelDiaLima, minutosAHhmm } from "../lib/alertas-horario";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (nombre: string, c: boolean) => { if (c) ok++; else { mal++; if (fallas.length < 40) fallas.push(nombre); } };

// ── 0. proximaAtencion nueva ≡ la vieja (copiada literal antes de extraer aperturaSiguiente) ──
const NOMBRE_DIA_V = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const minutosV = (hhmm: unknown): number | null => { const h = horaHHMM(hhmm); return h == null ? null : hhmmAMinutos(h); };
const fechaValidaV = (f: unknown): f is string =>
  typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T12:00:00Z`));
const aLasV = (hhmm: string) => (hhmm.startsWith("01:") ? `la ${hhmm}` : `las ${hhmm}`);
function proximaAtencionVieja(at: Atencion, fecha: string, hhmm: string): string | null {
  const m = minutosV(hhmm);
  if (!atencionValida(at) || !fechaValidaV(fecha) || m == null) return null;
  const desde = minutosV(at.desde)!, hasta = minutosV(at.hasta)!;
  const abre = `desde ${aLasV(horaHHMM(at.desde)!)}`;
  if (at.dias.includes(diaSemanaLima(fecha))) {
    if (m < desde) return `hoy ${abre}`;
    if (m < hasta) return "ahora";
  }
  for (let k = 1; k <= 7; k++) {
    const d = diaSemanaLima(sumarDias(fecha, k));
    if (!at.dias.includes(d)) continue;
    if (k === 1) return `mañana ${NOMBRE_DIA_V[d]} ${abre}`;
    return `${k === 7 ? "el próximo" : "el"} ${NOMBRE_DIA_V[d]} ${abre}`;
  }
  return null;
}

const H: Record<string, Atencion> = {
  lun_sab: { activa: true, dias: [1, 2, 3, 4, 5, 6], desde: "09:00", hasta: "18:00" },
  lun_vie: { activa: true, dias: [1, 2, 3, 4, 5], desde: "08:00", hasta: "17:00" },
  todos: { activa: true, dias: [0, 1, 2, 3, 4, 5, 6], desde: "07:00", hasta: "22:00" },
  mar_jue: { activa: true, dias: [2, 4], desde: "10:00", hasta: "12:00" },
};
const raros: Atencion[] = [
  { activa: true, dias: [], desde: "09:00", hasta: "17:00" },
  { activa: true, dias: [1], desde: "17:00", hasta: "09:00" },
  { activa: true, dias: [1, 9], desde: "09:00", hasta: "17:00" },
  { activa: true, dias: [3], desde: "01:00", hasta: "01:30" },
  { activa: false, dias: [1, 2, 3], desde: "09:00", hasta: "17:00" },
];
{
  let iguales = 0, total = 0;
  const fechas = ["2026-10-19", "2026-10-24", "2026-10-25", "2026-12-31", "2027-01-01", "2026-02-30", "x"];
  for (const at of [...Object.values(H), ...raros]) for (const f of fechas) for (let m = 0; m < 1440; m += 5) {
    const hh = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    total++;
    if (proximaAtencion(at, f, hh) === proximaAtencionVieja(at, f, hh)) iguales++;
  }
  for (const raro of ["25:00", "", "9", "aa:bb"]) { total++; if (proximaAtencion(H.lun_sab, "2026-10-19", raro) === proximaAtencionVieja(H.lun_sab, "2026-10-19", raro)) iguales++; }
  t(`proximaAtencion nueva ≡ vieja (${iguales}/${total})`, iguales === total);
  const a = aperturaSiguiente(H.lun_sab, "2026-10-24", "18:30"); // sábado después del cierre
  t("aperturaSiguiente sábado noche → lunes", a?.k === 2 && a.fecha === "2026-10-26" && a.desde === "09:00" && !a.ahora);
  t("aperturaSiguiente dentro → ahora", aperturaSiguiente(H.lun_sab, "2026-10-19", "10:00")?.ahora === true);
}

// ── 1. sumarMinutosAtencion ≡ oráculo minuto a minuto ────────────────────────
function dentroMin(at: Atencion, ms: number): boolean {
  const f = fechaLima(ms), m = minutoDelDiaLima(ms);
  return at.dias.includes(diaSemanaLima(f)) && m >= hhmmAMinutos(at.desde)! && m < hhmmAMinutos(at.hasta)!;
}
function oraculo(at: Atencion, desdeMs: number, mins: number): number {
  let t0 = desdeMs, r = mins;
  if (r === 0) { while (!dentroMin(at, t0)) t0 += 60_000; return t0; }
  while (r > 0) { if (dentroMin(at, t0)) r--; t0 += 60_000; }
  // El último minuto contado termina en t0; si después de él empieza un hueco, el plazo es t0.
  return t0;
}
{
  const base = limaAUtcMs("2026-10-19", "00:00")!;
  let iguales = 0, total = 0;
  for (const at of Object.values(H)) for (let paso = 0; paso < 7 * 96; paso += 7) for (const P of [0, 1, 15, 60, 120, 480]) {
    const desde = base + paso * 15 * 60_000;
    total++;
    if (sumarMinutosAtencion(at, desde, P) === oraculo(at, desde, P)) iguales++;
  }
  t(`sumarMinutosAtencion ≡ oráculo (${iguales}/${total})`, iguales === total);
  t("sumarMinutosAtencion sin horario válido → null", sumarMinutosAtencion(raros[0], base, 10) === null && sumarMinutosAtencion(raros[1], base, 10) === null);
  // Lunes 16:30, Lun–Sáb 9–18, P=120 → 90 min hoy + 30 min mañana: martes 09:30.
  t("16:30 + 120 min de atención → mañana 09:30", sumarMinutosAtencion(H.lun_sab, limaAUtcMs("2026-10-19", "16:30")!, 120) === limaAUtcMs("2026-10-20", "09:30"));
  t("ultimoInstanteAtencionAntes martes 05:00 → lunes 18:00", ultimoInstanteAtencionAntes(H.lun_sab, limaAUtcMs("2026-10-20", "05:00")!) === limaAUtcMs("2026-10-19", "18:00"));
}

// ── 2. El barrido de ordenDeReserva ──────────────────────────────────────────
const cfg = (P: number, M: number, pct: number | null = 50): ConfigReserva => ({ activa: true, adelantoPct: pct, correo: null, plazoConfirmacionMin: P, margenMin: M, devolucionPlazoH: 48 });
const enVentana = (at: Atencion, ms: number) => {
  const f = fechaLima(ms), m = minutoDelDiaLima(ms);
  return at.dias.includes(diaSemanaLima(f)) && m >= hhmmAMinutos(at.desde)! && m <= hhmmAMinutos(at.hasta)!;
};
const vistas = new Set<string>();
const visto = (a: string) => vistas.add(a);
{
  const base = limaAUtcMs("2026-10-19", "00:00")!; // lunes
  let casos = 0, reglaOk = 0, ventanaOk = 0, zonaOk = 0, monoServicioOk = 0, monoServicio = 0;
  let formatoOk = true;
  for (const [nombre, at] of Object.entries(H)) for (const P of [15, 120, 480]) for (const M of [0, 360, 1440]) {
    for (let paso = 0; paso < 7 * 96; paso++) {
      const ahora = base + paso * 15 * 60_000;
      let previoPedir = false;
      for (let hh = 0; hh <= 72; hh++) {
        const inicio = ahora + hh * 3_600_000;
        const o = ordenDeReserva({ ahoraMs: ahora, inicioMs: inicio, atencion: at, cfg: cfg(P, M), elegibilidad: [] });
        casos++; visto(o.accion);
        // La regla, dicha aparte.
        const apertura = sumarMinutosAtencion(at, ahora, 0)!;
        const C = sumarMinutosAtencion(at, ahora, P)!;
        const esperado = inicio <= ahora || apertura >= inicio ? "derivar" : C + M * 60_000 <= inicio ? "pedir_pago" : "confirmar_disponibilidad";
        if (o.accion === esperado) reglaOk++;
        else if (fallas.length < 40) fallas.push(`regla ${nombre} P${P} M${M} paso${paso} +${hh}h: ${o.accion} ≠ ${esperado}`);
        if (o.confirmarAntesMs == null ? o.accion === "derivar" : enVentana(at, o.confirmarAntesMs) && o.confirmarAntesMs >= ahora) ventanaOk++;
        else if (fallas.length < 40) fallas.push(`ventana ${nombre} P${P} M${M} paso${paso} +${hh}h`);
        if (o.accion === "pedir_pago" && !(o.confirmarAntesMs! + M * 60_000 <= inicio && o.motivos.length === 0 && !o.urgente)) fallas.push("pedir_pago sin su margen");
        if (!o.motivos.every((m) => /^[a-z_]{2,40}$/.test(m))) formatoOk = false;
        // Un servicio más tarde nunca quita pedir_pago.
        if (previoPedir) { monoServicio++; if (o.accion === "pedir_pago") monoServicioOk++; }
        previoPedir = previoPedir || o.accion === "pedir_pago";
        // zona_sin_envio nunca pide el pago (cada 3 pasos, para no triplicar el barrido).
        if (paso % 3 === 0) {
          const z = ordenDeReserva({ ahoraMs: ahora, inicioMs: inicio, atencion: at, cfg: cfg(P, M), elegibilidad: ["zona_sin_envio"] });
          if (z.accion !== "pedir_pago" && z.motivos.includes("zona_sin_envio")
            && (o.accion === "derivar" ? z.accion === "derivar" : z.accion === "confirmar_disponibilidad")) zonaOk++;
          else if (fallas.length < 40) fallas.push(`zona ${nombre} paso${paso} +${hh}h: ${z.accion}`);
        }
      }
    }
  }
  const zonaCasos = 4 * 3 * 3 * Math.ceil((7 * 96) / 3) * 73;
  t(`pedir_pago ⟺ la regla (${reglaOk}/${casos})`, reglaOk === casos);
  t(`el plazo siempre en una ventana de atención (${ventanaOk}/${casos})`, ventanaOk === casos);
  t(`zona_sin_envio nunca pide el pago (${zonaOk}/${zonaCasos})`, zonaOk === zonaCasos);
  t(`un servicio más tarde nunca quita pedir_pago (${monoServicioOk}/${monoServicio})`, monoServicio > 0 && monoServicioOk === monoServicio);
  t("formato de los motivos [a-z_]{2,40}", formatoOk);
  t("corolario: salen las tres acciones", vistas.has("pedir_pago") && vistas.has("confirmar_disponibilidad") && vistas.has("derivar"));
}

// ── 3. Más tarde «ahora» nunca hace aparecer pedir_pago (inicio fijo) ─────────
{
  const base = limaAUtcMs("2026-10-19", "00:00")!;
  let pares = 0, buenos = 0;
  for (const at of Object.values(H)) for (const P of [15, 120, 480]) for (const M of [0, 360, 1440]) {
    for (let hi = 3; hi < 7 * 24 + 48; hi += 3) {
      const inicio = base + hi * 3_600_000;
      let yaNo = false;
      for (let ahora = base; ahora < inicio; ahora += 15 * 60_000) {
        const o = ordenDeReserva({ ahoraMs: ahora, inicioMs: inicio, atencion: at, cfg: cfg(P, M), elegibilidad: [] });
        if (yaNo) { pares++; if (o.accion !== "pedir_pago") buenos++; }
        if (o.accion !== "pedir_pago") yaNo = true;
      }
    }
  }
  t(`más tarde «ahora» nunca hace aparecer pedir_pago (${buenos}/${pares})`, pares > 0 && buenos === pares);
}

// ── 4. Casos con nombre ──────────────────────────────────────────────────────
{
  const at = H.lun_sab;
  const ahora = limaAUtcMs("2026-10-19", "21:00")!; // lunes 21:00
  const inicio = limaAUtcMs("2026-10-20", "05:00")!; // martes 05:00
  const o = ordenDeReserva({ ahoraMs: ahora, inicioMs: inicio, atencion: at, cfg: cfg(120, 360), elegibilidad: [] });
  t("21:00 con servicio mañana 05:00 → derivar", o.accion === "derivar" && o.urgente && o.motivos.includes("no_llega") && o.confirmarAntesMs === null);
  const z = ordenDeReserva({ ahoraMs: ahora, inicioMs: inicio, atencion: at, cfg: cfg(120, 360), elegibilidad: ["zona_sin_envio"] });
  t("21:00 / 05:00 con zona sin envío → derivar (no pedir_pago)", z.accion === "derivar");

  // De noche SÍ se pide el pago si la próxima apertura + P + M llega a tiempo.
  const noche = ordenDeReserva({ ahoraMs: ahora, inicioMs: limaAUtcMs("2026-10-21", "08:00")!, atencion: at, cfg: cfg(120, 360), elegibilidad: [] });
  t("de noche con servicio pasado mañana → pedir_pago, plazo mañana 11:00", noche.accion === "pedir_pago" && noche.confirmarAntesMs === limaAUtcMs("2026-10-20", "11:00"));
  t("frasePlazo «mañana martes antes de las 11:00»", frasePlazo(noche.confirmarAntesMs, ahora) === "mañana martes antes de las 11:00");

  // Dentro del horario, poco tiempo: confirmar ya, urgente, plazo antes del cierre.
  const ahora2 = limaAUtcMs("2026-10-19", "16:30")!;
  const pronto = ordenDeReserva({ ahoraMs: ahora2, inicioMs: limaAUtcMs("2026-10-20", "05:00")!, atencion: at, cfg: cfg(120, 360), elegibilidad: [] });
  t("16:30 con servicio 05:00 → confirmar ya (muy_pronto), plazo 18:00", pronto.accion === "confirmar_disponibilidad" && pronto.urgente && pronto.motivos.includes("muy_pronto") && pronto.confirmarAntesMs === limaAUtcMs("2026-10-19", "18:00"));
  t("frasePlazo «hoy antes de las 18:00»", frasePlazo(pronto.confirmarAntesMs, ahora2) === "hoy antes de las 18:00");

  // Fuera de horario y no alcanza desde la apertura.
  const ahora3 = limaAUtcMs("2026-10-19", "07:00")!;
  const tras = ordenDeReserva({ ahoraMs: ahora3, inicioMs: limaAUtcMs("2026-10-19", "15:00")!, atencion: at, cfg: cfg(120, 360), elegibilidad: [] });
  t("07:00 con servicio 15:00 → no_alcanza_tras_apertura", tras.accion === "confirmar_disponibilidad" && tras.motivos.includes("no_alcanza_tras_apertura") && tras.urgente);

  // Sin horario en uso: nunca pago, sin plazo.
  const sinH = ordenDeReserva({ ahoraMs: ahora2, inicioMs: limaAUtcMs("2026-10-25", "10:00")!, atencion: { ...at, activa: false }, cfg: cfg(120, 360), elegibilidad: [] });
  t("sin horario → confirmar_disponibilidad sin plazo", sinH.accion === "confirmar_disponibilidad" && sinH.confirmarAntesMs === null && sinH.motivos.includes("sin_horario_equipo") && !sinH.urgente);
  // Sin hora del servicio.
  const sinHora = ordenDeReserva({ ahoraMs: ahora2, inicioMs: null, atencion: at, cfg: cfg(120, 360), elegibilidad: [] });
  t("sin hora → confirmar_disponibilidad con plazo", sinHora.accion === "confirmar_disponibilidad" && sinHora.motivos.includes("sin_hora") && sinHora.confirmarAntesMs != null);
  // Servicio pasado.
  const pasado = ordenDeReserva({ ahoraMs: ahora2, inicioMs: ahora2 - 60_000, atencion: at, cfg: cfg(120, 360), elegibilidad: [] });
  t("servicio pasado → derivar", pasado.accion === "derivar" && pasado.motivos.includes("servicio_pasado"));
  // Sin porcentaje configurado: confirmar primero aunque sobre tiempo.
  const sinPct = ordenDeReserva({ ahoraMs: ahora2, inicioMs: limaAUtcMs("2026-10-25", "10:00")!, atencion: at, cfg: cfg(120, 360, null), elegibilidad: [] });
  t("sin porcentaje → sin_adelanto_config", sinPct.accion === "confirmar_disponibilidad" && sinPct.motivos.includes("sin_adelanto_config"));
  const cred = ordenDeReserva({ ahoraMs: ahora2, inicioMs: limaAUtcMs("2026-10-25", "10:00")!, atencion: at, cfg: cfg(120, 360, null), elegibilidad: ["credito"] });
  t("crédito: no se suma sin_adelanto_config", cred.accion === "confirmar_disponibilidad" && cred.motivos.includes("credito") && !cred.motivos.includes("sin_adelanto_config"));
  // Motivos desconocidos y repetidos se descartan.
  const raro = ordenDeReserva({ ahoraMs: ahora2, inicioMs: limaAUtcMs("2026-10-25", "10:00")!, atencion: at, cfg: cfg(120, 360), elegibilidad: ["cuentas_distintas", "cuentas_distintas", "otra_cosa" as MotivoOrden] });
  t("motivos repetidos y desconocidos se descartan", raro.motivos.join(",") === "cuentas_distintas");
  t("ordenDeSolicitud", ordenDeSolicitud("pedir_pago") === "pago_primero" && ordenDeSolicitud("derivar") === "disponibilidad_primero" && ordenDeSolicitud("confirmar_disponibilidad") === "disponibilidad_primero");
  t("confirmarAntesDe ≡ el plazo de ordenDeReserva", confirmarAntesDe(at, ahora, 120) === noche.confirmarAntesMs && confirmarAntesDe({ ...at, activa: false }, ahora, 120) === null);

  // frasePlazo: el resto de las formas.
  const lunes = limaAUtcMs("2026-10-19", "10:00")!;
  t("frasePlazo el jueves", frasePlazo(limaAUtcMs("2026-10-22", "11:00"), lunes) === "el jueves antes de las 11:00");
  t("frasePlazo a una semana lleva la fecha", frasePlazo(limaAUtcMs("2026-10-27", "11:00"), lunes) === "el martes 27/10 antes de las 11:00");
  t("frasePlazo «la 01:30»", frasePlazo(limaAUtcMs("2026-10-19", "01:30"), limaAUtcMs("2026-10-19", "00:10")!) === "hoy antes de la 01:30");
  t("frasePlazo sin plazo → null", frasePlazo(null, lunes) === null);
}

// ── 5. Defectos, plazos y elegibilidad ───────────────────────────────────────
{
  t("defectos P=120, M=360", PLAZO_CONFIRMACION_DEFECTO_MIN === 120 && MARGEN_DEFECTO_MIN === 360);
  const d = plazosDe(normalizarConfigReserva(null));
  t("sin config → P y M por defecto", d.P === 120 && d.M === 360);
  const fuera = plazosDe({ plazoConfirmacionMin: 5, margenMin: 9999 });
  t("fuera de rango → defecto", fuera.P === 120 && fuera.M === 360);
  const base = { zonaConEnvio: true, cotizacionEnviada: true, validezHasta: "2026-11-30", hoy: "2026-10-22", inicioMs: limaAUtcMs("2026-11-01", "10:00"), ahoraMs: limaAUtcMs("2026-10-22", "10:00")!, adelantoPct: 50, credito: false, cuentas: 2, cuentasFrente: "iguales" as const, perfilConfigurado: true, politicaSospechosa: false };
  t("elegible → sin motivos", elegibilidadDeReserva(base).length === 0);
  const todo = elegibilidadDeReserva({ ...base, zonaConEnvio: false, cotizacionEnviada: false, validezHasta: "2026-10-01", inicioMs: base.ahoraMs - 1, adelantoPct: null, cuentas: 0, cuentasFrente: "distintas", perfilConfigurado: false, politicaSospechosa: true });
  t("todos los motivos de elegibilidad", ["zona_sin_envio", "cotizacion_no_enviada", "cotizacion_vencida", "servicio_pasado", "sin_adelanto_config", "sin_cuentas", "cuentas_distintas", "perfil_sin_configurar", "politica_sospechosa"].every((m) => todo.includes(m as never)));
  t("crédito: credito y no sin_adelanto_config ni sin_cuentas", (() => { const c = elegibilidadDeReserva({ ...base, credito: true, adelantoPct: null, cuentas: 0 }); return c.includes("credito") && !c.includes("sin_adelanto_config") && !c.includes("sin_cuentas"); })());
  t("sin_comprobar cuenta como cuentas_distintas", elegibilidadDeReserva({ ...base, cuentasFrente: "sin_comprobar" }).includes("cuentas_distintas"));
  // `cotizacion_corregida` no lo pone ordenDeReserva (lo agrega quien crea la solicitud), pero va a la tarjeta y al correo igual.
  const todos = [...MOTIVOS_ELEGIBILIDAD, ...MOTIVOS_TIEMPO, ...MOTIVOS_CORRECCION];
  t("cotizacion_corregida como elegibilidad no la acepta el orden (no es suyo)", !ordenDeReserva({ ahoraMs: limaAUtcMs("2026-10-22", "10:00")!, inicioMs: limaAUtcMs("2026-11-01", "10:00"), atencion: { activa: true, dias: [1, 2, 3, 4, 5, 6], desde: "09:00", hasta: "18:00" } as any, cfg: { adelantoPct: 50 } as any, elegibilidad: ["cotizacion_corregida" as MotivoOrden] }).motivos.includes("cotizacion_corregida"));
  t("todo motivo tiene su texto para el ejecutivo", todos.every((m) => typeof MOTIVO_ORDEN[m] === "string" && MOTIVO_ORDEN[m].length > 10));
  t("todo motivo cumple el CHECK de la base [a-z_]{2,40}", todos.every((m) => /^[a-z_]{2,40}$/.test(m)));
}

// ── 6. frasePlazo en inglés, y el castellano intacto ─────────────────────────
{
  // La de antes del inglés (lib/traslados/reserva-orden.ts de 93c594b), copiada literal.
  const fechaCortaV = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const frasePlazoVieja = (confirmarAntesMs: number | null | undefined, ahoraMs: number): string | null => {
    if (typeof confirmarAntesMs !== "number" || !Number.isFinite(confirmarAntesMs) || !Number.isFinite(ahoraMs)) return null;
    const hoy = fechaLima(ahoraMs), dia = fechaLima(confirmarAntesMs);
    const hora = aLasV(minutosAHhmm(minutoDelDiaLima(confirmarAntesMs)));
    const k = Math.round((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)) / 86_400_000);
    const nd = NOMBRE_DIA_V[diaSemanaLima(dia)];
    if (k <= 0) return `hoy antes de ${hora}`;
    if (k === 1) return `mañana ${nd} antes de ${hora}`;
    if (k < 7) return `el ${nd} antes de ${hora}`;
    return `el ${nd} ${fechaCortaV(dia)} antes de ${hora}`;
  };
  const DIA_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FUGA = /(?<![\p{L}\p{N}])(?:hoy|mañana|antes|de|las?|el|lunes|martes|miércoles|jueves|viernes|sábado|domingo|hora)(?![\p{L}\p{N}])|[áéíóúñ¿¡]/iu;
  let n = 0, distintas = 0;
  const formas = new Set<string>();
  for (const ahora0 of [limaAUtcMs("2026-10-19", "00:10")!, limaAUtcMs("2026-10-24", "23:50")!, limaAUtcMs("2026-12-28", "09:00")!]) {
    for (let d = -1; d < 12; d++) for (let m = 0; m < 1440; m += 37) {
      const ms = ahora0 + d * 86_400_000 + m * 60_000;
      const v = frasePlazoVieja(ms, ahora0), es = frasePlazo(ms, ahora0), esX = frasePlazo(ms, ahora0, "es"), en = frasePlazo(ms, ahora0, "en")!;
      n++;
      if (v !== es || v !== esX) distintas++;
      const hh = minutosAHhmm(minutoDelDiaLima(ms));
      const dia = fechaLima(ms), hoy = fechaLima(ahora0);
      const k = Math.round((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)) / 86_400_000);
      const dn = DIA_EN[diaSemanaLima(dia)];
      const esperado = k <= 0 ? `today by ${hh} (Lima time)`
        : k === 1 ? `tomorrow, ${dn}, by ${hh} (Lima time)`
        : k < 7 ? `on ${dn} by ${hh} (Lima time)`
        : `on ${dn}, ${MES_EN[Number(dia.slice(5, 7)) - 1]} ${Number(dia.slice(8, 10))}, by ${hh} (Lima time)`;
      if (en !== esperado) t(`frasePlazo en ${dia} ${hh}: «${en}» ≠ «${esperado}»`, false);
      if (FUGA.test(en)) t(`frasePlazo en sin castellano: «${en}»`, false);
      if (!es!.includes(hh) || !en.includes(hh)) t(`la misma hora en los dos (${hh})`, false);
      formas.add(/^on \w+, /.test(en) ? "on_fecha" : en.split(" ")[0]);
    }
  }
  t(`frasePlazo sin idioma y con «es» ≡ la de 93c594b (${n} plazos)`, distintas === 0 && n === 3 * 13 * 39);
  t("frasePlazo en inglés: salen las cuatro formas (corolario)", ["today", "tomorrow,", "on", "on_fecha"].every((f) => formas.has(f)) && formas.size === 4);
  const lunes = limaAUtcMs("2026-10-19", "10:00")!;
  t("frasePlazo en: hoy", frasePlazo(limaAUtcMs("2026-10-19", "15:30"), lunes, "en") === "today by 15:30 (Lima time)");
  t("frasePlazo en: mañana", frasePlazo(limaAUtcMs("2026-10-20", "11:00"), lunes, "en") === "tomorrow, Tuesday, by 11:00 (Lima time)");
  t("frasePlazo en: el jueves", frasePlazo(limaAUtcMs("2026-10-22", "11:00"), lunes, "en") === "on Thursday by 11:00 (Lima time)");
  t("frasePlazo en: a una semana, el mes por su nombre", frasePlazo(limaAUtcMs("2026-10-27", "11:00"), lunes, "en") === "on Tuesday, Oct 27, by 11:00 (Lima time)");
  t("frasePlazo en: 01:30 sin «la»", frasePlazo(limaAUtcMs("2026-10-19", "01:30"), limaAUtcMs("2026-10-19", "00:10")!, "en") === "today by 01:30 (Lima time)");
  t("frasePlazo en: sin plazo → null", frasePlazo(null, lunes, "en") === null && frasePlazo(NaN, lunes, "en") === null && frasePlazo(lunes, NaN, "en") === null);
  t("frasePlazo en: cambio de año", frasePlazo(limaAUtcMs("2027-01-05", "09:30"), limaAUtcMs("2026-12-28", "09:00")!, "en") === "on Tuesday, Jan 5, by 09:30 (Lima time)");
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0 || fallas.length > 0) process.exit(1);
console.log("Todo OK");
