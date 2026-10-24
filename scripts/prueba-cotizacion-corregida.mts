// npx tsx scripts/prueba-cotizacion-corregida.mts
// La regla de una cotización de traslado CORREGIDA por una persona (lib/traslados/cotizacion-corregida.ts):
// la IA la usa solo tras la pausa del ejecutivo (`pausa_humano_horas`) o una reactivación posterior.
// Fija:
//  · cada código, en su orden (de la evidencia al juicio), y su `usar`;
//  · la frontera EXACTA de las N h (la del chat: `inicioVentanaHumano` + gte, una corrección de hace
//    exactamente N h todavía aparta a la IA) y la de la reactivación (estrictamente DESPUÉS);
//  · horas 0 / negativas / basura, fechas ilegibles, «no se sabe» (undefined) frente a null;
//  · un barrido con las invariantes: nunca se usa una fila corregida dentro de la ventana sin una
//    reactivación posterior (con horas > 0), y la regla coincide con `inicioVentanaHumano` en todo el
//    barrido — con el corolario: el barrido SÍ produce juicios que dejan usar la fila;
//  · los textos de las notas: sin cifras de dinero, con las horas en Lima y sin nada para el cliente.
import {
  CODIGOS_CORRECCION, CORRECCION, SQL_ACTIVIDAD_EJECUTIVO, horaLimaNota, horasDePausa, juzgarCotizacionCorregida, notaEsperaCorreccion,
  notaSolicitudCorregida, notaUsoCorreccion, puedeUsar, type CodigoCorreccion, type JuicioCorreccion,
} from "../lib/traslados/cotizacion-corregida";
import { HORAS_PAUSA_DEFECTO, horasPausaHumano, inicioVentanaHumano } from "../lib/crm-ia-reactivacion";
import { horasPausaHumano as horasPausaHumanoCrm } from "../lib/crm-ia";
import { mencionaDinero } from "../lib/traslados/texto-libre";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; if (fallas.length < 40) fallas.push(n); } };

const H = 3_600_000;
// Miércoles 21-10-2026, 10:00 de Lima.
const ahora = Date.parse("2026-10-21T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const J = (x: Partial<Parameters<typeof juzgarCotizacionCorregida>[0]>): JuicioCorreccion =>
  juzgarCotizacionCorregida({ editada: true, editadaAt: iso(ahora - H), horasPausa: 12, reactivadaAt: null, ahoraMs: ahora, ...x });

// ── 1. Cada código ───────────────────────────────────────────────────────────
{
  t("no corregida → sin_cambios (aunque la hora sea reciente o no se sepa)", J({ editada: false }).codigo === "sin_cambios" && J({ editada: false, editadaAt: undefined }).codigo === "sin_cambios");
  t("horas 0 → pausa_apagada (aunque no se sepa la hora)", J({ horasPausa: 0 }).codigo === "pausa_apagada" && J({ horasPausa: 0, editadaAt: undefined }).codigo === "pausa_apagada");
  t("horas negativas → pausa_apagada (como el chat: solo `> 0` aparta)", J({ horasPausa: -3 }).codigo === "pausa_apagada");
  t("sin la columna o sin poder leerla (undefined) → sin_hora, espera", (() => { const j = J({ editadaAt: undefined }); return j.codigo === "sin_hora" && !j.usar && j.retomaMs == null; })());
  t("null (ninguna persona la tocó) → sin_persona, usa", (() => { const j = J({ editadaAt: null }); return j.codigo === "sin_persona" && j.usar; })());
  t("fecha ilegible → sin_hora", ["basura", "", "  ", "2026-13-45T99:00:00Z"].every((v) => J({ editadaAt: v }).codigo === "sin_hora"));
  t("ahora ilegible → sin_hora", J({ ahoraMs: NaN }).codigo === "sin_hora");
  t("hace 1 h con 12 h → ejecutivo_activo con retomaMs = edición + 12 h", (() => { const j = J({}); return j.codigo === "ejecutivo_activo" && !j.usar && j.editadaMs === ahora - H && j.retomaMs === ahora - H + 12 * H; })());
  t("hace 13 h con 12 h → pausa_cumplida", (() => { const j = J({ editadaAt: iso(ahora - 13 * H) }); return j.codigo === "pausa_cumplida" && j.usar && j.retomaMs == null; })());
  t("reactivada después de la corrección → reactivada", (() => { const j = J({ reactivadaAt: iso(ahora - 30 * 60_000) }); return j.codigo === "reactivada" && j.usar; })());
  t("reactivada ANTES de la corrección → sigue esperando", J({ reactivadaAt: iso(ahora - 2 * H) }).codigo === "ejecutivo_activo");
  t("reactivada en el MISMO instante de la corrección → espera (tiene que ser después)", J({ reactivadaAt: iso(ahora - H) }).codigo === "ejecutivo_activo");
  t("reactivación ilegible → como si no hubiera", J({ reactivadaAt: "x" }).codigo === "ejecutivo_activo" && J({ reactivadaAt: undefined }).codigo === "ejecutivo_activo");
  t("una corrección con la hora en el FUTURO (reloj de la base adelantado) → espera", (() => { const j = J({ editadaAt: iso(ahora + 5 * 60_000) }); return j.codigo === "ejecutivo_activo" && j.retomaMs === ahora + 5 * 60_000 + 12 * H; })());
  t("horas basura → las del defecto (12)", J({ horasPausa: NaN }).horas === HORAS_PAUSA_DEFECTO && J({ horasPausa: "x" as unknown as number }).horas === 12 && horasDePausa(undefined) === 12);
  t("horas fraccionarias (1.5 h)", J({ horasPausa: 1.5, editadaAt: iso(ahora - 2 * H) }).codigo === "pausa_cumplida" && J({ horasPausa: 1.5 }).codigo === "ejecutivo_activo");
  t("todo código tiene su `usar` y su texto", CODIGOS_CORRECCION.length === 7 && CODIGOS_CORRECCION.every((c) => typeof CORRECCION[c].usar === "boolean" && CORRECCION[c].texto.length > 10));
  t("esperan SOLO sin_hora y ejecutivo_activo", CODIGOS_CORRECCION.filter((c) => !CORRECCION[c].usar).sort().join() === "ejecutivo_activo,sin_hora");
  t("puedeUsar es el `usar` del código", CODIGOS_CORRECCION.every((c) => puedeUsar({ codigo: c }) === CORRECCION[c].usar));
  t("el texto de sin_hora nombra la migración", CORRECCION.sin_hora.texto.includes(SQL_ACTIVIDAD_EJECUTIVO));
}

// ── 2. Las fronteras exactas ─────────────────────────────────────────────────
{
  for (const h of [1, 6, 12, 24]) {
    const ed = ahora - h * H;
    t(`${h} h: a EXACTAMENTE ${h} h todavía espera (como el chat)`, J({ horasPausa: h, editadaAt: iso(ed) }).codigo === "ejecutivo_activo");
    t(`${h} h: 1 ms después ya usa`, J({ horasPausa: h, editadaAt: iso(ed - 1) }).codigo === "pausa_cumplida");
    t(`${h} h: el chat diría lo mismo en la frontera`, ed >= Date.parse(inicioVentanaHumano(ahora, h, null)) && !(ed - 1 >= Date.parse(inicioVentanaHumano(ahora, h, null))));
  }
  const ed = ahora - H;
  t("reactivación 1 ms después de la corrección → usa", J({ editadaAt: iso(ed), reactivadaAt: iso(ed + 1) }).codigo === "reactivada");
  t("reactivación 1 ms antes → espera", J({ editadaAt: iso(ed), reactivadaAt: iso(ed - 1) }).codigo === "ejecutivo_activo");
}

// ── 3. horasPausaHumano: la misma lectura en los dos módulos ─────────────────
{
  const casos: unknown[] = [undefined, null, 0, 6, "6", "x", -2, 1.5, Infinity, NaN, ""];
  t("horasPausaHumano: 12 sin número, null es 0, texto numérico vale", horasPausaHumano({}) === 12 && horasPausaHumano({ pausa_humano_horas: null }) === 0 && horasPausaHumano({ pausa_humano_horas: "6" }) === 6 && horasPausaHumano({ pausa_humano_horas: "x" }) === 12 && horasPausaHumano(null) === 12);
  t("crm-ia reexporta la misma lectura (todos los casos)", casos.every((v) => Object.is(horasPausaHumano({ pausa_humano_horas: v }), horasPausaHumanoCrm({ pausa_humano_horas: v }))));
}

// ── 4. El barrido ────────────────────────────────────────────────────────────
{
  let n = 0, usan = 0, esperan = 0, cruce = 0, invariante = 0;
  const vistos = new Set<CodigoCorreccion>();
  for (const editada of [false, true])
    for (const horas of [-1, 0, 0.5, 1, 6, 12, 24, 48])
      for (const edMin of [-5000, -2900, -1441, -1440, -721, -720, -719, -361, -360, -60, -1, 0, 30, null, undefined] as (number | null | undefined)[])
        for (const reMin of [null, -6000, -3000, -800, -720, -100, -61, -60, -59, -30, -1, 0, 10] as (number | null)[]) {
          const editadaAt = edMin === undefined ? undefined : edMin === null ? null : iso(ahora + edMin * 60_000);
          const reactivadaAt = reMin === null ? null : iso(ahora + reMin * 60_000);
          const j = juzgarCotizacionCorregida({ editada, editadaAt, horasPausa: horas, reactivadaAt, ahoraMs: ahora });
          n++; vistos.add(j.codigo);
          if (j.usar) usan++; else esperan++;
          // INVARIANTE: corregida, con pausa, con la hora conocida dentro de la ventana y sin una
          // reactivación posterior → nunca se usa.
          if (editada && horas > 0 && typeof edMin === "number") {
            const ed = ahora + edMin * 60_000;
            const re = reMin === null ? null : ahora + reMin * 60_000;
            const dentro = ed >= ahora - horas * H;
            const reactivoDespues = re != null && re > ed;
            if (dentro && !reactivoDespues && j.usar) { invariante++; if (fallas.length < 40) fallas.push(`invariante: ${JSON.stringify({ horas, edMin, reMin, j })}`); }
            // El mismo juicio que la ventana del chat: una corrección cuenta como actividad ⟺ cae desde
            // `inicioVentanaHumano`.
            const cuenta = ed >= Date.parse(inicioVentanaHumano(ahora, horas, reactivadaAt));
            if (cuenta === j.usar) { cruce++; if (fallas.length < 40) fallas.push(`cruce: ${JSON.stringify({ horas, edMin, reMin, codigo: j.codigo })}`); }
            if (j.codigo === "ejecutivo_activo" && j.retomaMs !== ed + horas * H) { invariante++; }
          }
          // Lo que no se sabe nunca deja usar la fila (salvo sin pausa, o sin corrección).
          if (editada && horas > 0 && edMin === undefined && j.usar) invariante++;
          // Sin corrección SIEMPRE se usa, y nunca se espera sin una corrección.
          if (!editada && (!j.usar || j.codigo !== "sin_cambios")) invariante++;
        }
  console.log(`barrido: ${n} casos · ${usan} usan la fila · ${esperan} esperan`);
  t(`barrido: ninguna fila corregida se usa dentro de la ventana sin reactivación posterior (${n} casos)`, invariante === 0);
  t("barrido: el juicio coincide con `inicioVentanaHumano` (la frontera del chat)", cruce === 0);
  t(`barrido: el corolario — también deja usar filas (${usan} usan, ${esperan} esperan)`, usan > 0 && esperan > 0);
  t("barrido: salen los siete códigos", CODIGOS_CORRECCION.every((c) => vistos.has(c)));
}

// ── 5. Las notas ─────────────────────────────────────────────────────────────
{
  t("horaLimaNota: mismo día → «HH:MM»; otro día → «HH:MM del DD/MM»", horaLimaNota(ahora - H, ahora) === "09:00" && horaLimaNota(ahora + 11 * H, ahora) === "21:00" && horaLimaNota(ahora + 15 * H, ahora) === "01:00 del 22/10" && horaLimaNota(null, ahora) === null);
  const activo = J({});
  const e = notaEsperaCorreccion(activo, { numero: "00736", que: "politicas", ahoraMs: ahora })!;
  t("nota de espera: el número, las dos horas, la pausa y cómo destrabarla", e.startsWith("🕒 La cotización N° 00736 se corrigió a las 09:00.") && e.includes("hasta las 21:00") && e.includes("pausa de 12 h") && e.includes("las políticas") && e.includes("reactiva la IA"));
  const madrugada = Date.parse("2026-10-21T07:00:00Z"), tarde = Date.parse("2026-10-21T19:00:00Z");
  const e1 = notaEsperaCorreccion(J({ editadaAt: iso(Date.parse("2026-10-21T06:20:00Z")), ahoraMs: madrugada }), { numero: "1", que: "adelanto", ahoraMs: madrugada })!;
  const e2 = notaEsperaCorreccion(J({ editadaAt: iso(Date.parse("2026-10-21T18:20:00Z")), ahoraMs: tarde }), { numero: "1", que: "adelanto", ahoraMs: tarde })!;
  t("nota de espera: «a la 01:20» (la 01 en singular) y «hasta la 01:20 del 22/10» (otro día)", e1.includes("se corrigió a la 01:20.") && e1.includes("hasta las 13:20") && e2.includes("se corrigió a las 13:20.") && e2.includes("hasta la 01:20 del 22/10"));
  const sh = notaEsperaCorreccion(J({ editadaAt: undefined }), { numero: "00736", que: "importes", ahoraMs: ahora })!;
  t("nota sin hora: nombra la migración y no promete una hora", sh.includes(SQL_ACTIVIDAD_EJECUTIVO) && !/hasta la/.test(sh) && sh.includes("los importes"));
  t("nota de espera: null cuando se puede usar", notaEsperaCorreccion(J({ editadaAt: iso(ahora - 13 * H) }), { numero: "1", que: "adelanto", ahoraMs: ahora }) === null && notaEsperaCorreccion(J({ editada: false }), { numero: "1", que: "adelanto", ahoraMs: ahora }) === null);
  t("nota de la solicitud: las dos horas y la tarjeta", notaSolicitudCorregida(activo, ahora) === "La cotización se corrigió a las 09:00: el adelanto lo pide el ejecutivo desde la tarjeta (la IA lo pediría desde las 21:00).");
  t("nota de la solicitud sin hora, y null si se usa", /no se sabe a qué hora/.test(notaSolicitudCorregida(J({ editadaAt: undefined }), ahora) ?? "") && notaSolicitudCorregida(J({ editada: false }), ahora) === null);
  const usos = (["pausa_cumplida", "reactivada", "pausa_apagada", "sin_persona"] as const).map((c) => {
    const j = c === "pausa_cumplida" ? J({ editadaAt: iso(ahora - 13 * H) }) : c === "reactivada" ? J({ reactivadaAt: iso(ahora - 60_000) }) : c === "pausa_apagada" ? J({ horasPausa: 0 }) : J({ editadaAt: null });
    return { c, j, n: notaUsoCorreccion(j, { numero: "00736", ahoraMs: ahora }) };
  });
  t("nota de uso: una por cada código que usa la fila corregida, con el porqué", usos.every((u) => u.j.codigo === u.c && !!u.n && u.n.includes("CORREGIDA") && u.n.includes("N° 00736")));
  t("nota de uso: null sin corrección o esperando", notaUsoCorreccion(J({ editada: false }), { numero: "1", ahoraMs: ahora }) === null && notaUsoCorreccion(activo, { numero: "1", ahoraMs: ahora }) === null);
  const todas = [e, e1, e2, sh, notaSolicitudCorregida(activo, ahora)!, ...usos.map((u) => u.n!)];
  t("ninguna nota habla de dinero ni trae importes", todas.every((x) => !mencionaDinero(x.replace(/pedido de adelanto con las cuentas|el adelanto|monto del adelanto|los importes de la cotización|los importes y las condiciones/g, ""))));
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0 || fallas.length > 0) process.exit(1);
console.log("Todo OK");
