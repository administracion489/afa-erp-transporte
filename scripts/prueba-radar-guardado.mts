// Pruebas del GUARDADO del Radar y de su reproceso. NO tocan la base: datos en memoria y un
// Supabase falso que responde como PostgREST.
// Uso:  npx tsx scripts/prueba-radar-guardado.mts   (sale con código 1 si algo falla)
//
// DEL 14/09 AL 06/10 EL RADAR NO GUARDÓ NINGUNA RECARGA. La fila de `radar_combustible` empezó a
// llevar `nivel_tanque`, de una migración que el deploy no corre; PostgREST la rechazó con
// PGRST204 «Could not find the 'nivel_tanque' column…», el respaldo solo reconocía «does not
// exist», la acción lanzó y el motor marcó el mensaje «Procesado» igual. Estas pruebas fijan:
//
//   1. el lector del error entiende las DOS formas (y el viejo, copiado literal, reproduce el bug);
//   2. el guardado suelta la columna accesoria que el error nombra, y SOLO esa;
//   3. una acción fallida deja el mensaje en ERROR, nunca en procesado;
//   4. la fecha del voucher se coteja contra la del mensaje (la CTV-370 fechada en 2025);
//   5. lo que ya está en /combustible —también lo que registró la FACTURA con un día de
//      diferencia— se reconoce y no se registra otra vez;
//   6. reprocesar un mensaje trae de vuelta SU ráfaga y nada más.
import { PostgrestClient } from "@supabase/postgrest-js";
import { columnaFaltante, faltaColumna, faltaAlguna } from "../lib/columna-faltante";
import { insertarFilaRadar, avisoColumnasQuitadas } from "../lib/radar/guardado-radar";
import { revisarFechaVoucher, MAX_ATRASO_DIAS, atrasoDias } from "../lib/radar/fecha-voucher";
import { buscarCargaRegistrada, comprobanteEnTexto, patronComprobante, type CargaRegistrada } from "../lib/radar/album-recargas";
import {
  estadoTrasAccion, rafagaAReactivar, raizDeReproceso, sinTerminar, esFallido, motivoDeFallo,
  FILTRO_FALLIDOS, FILTRO_SIN_TERMINAR, PATCH_QUITAR_DEL_AVISO, type MensajeRafaga,
} from "../lib/radar/reproceso";
import { miembrosDelMismoRemitente, pareceCombustible, remitenteUtilizable } from "../lib/radar/cluster-remitente";
import { observacionCargaDeFactura } from "../lib/combustible/factura-lineas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// Las frases EXACTAS que devuelven PostgREST y Postgres.
const PGRST204 = { code: "PGRST204", message: "Could not find the 'nivel_tanque' column of 'radar_combustible' in the schema cache" };
const E42703_REL = { code: "42703", message: 'column "nivel_tanque" of relation "radar_combustible" does not exist' };
const E42703_SEL = { code: "42703", message: "column radar_combustible.nivel_tanque does not exist" };
const CHECK = { code: "23514", message: 'new row for relation "radar_combustible" violates check constraint "radar_combustible_estado_check"' };

// ── 1. El lector del error ───────────────────────────────────────────────────
console.log("\n1. ¿Falta una columna, y cuál?");
{
  chk("PGRST204 (INSERT/UPDATE) → nombra la columna", columnaFaltante(PGRST204) === "nivel_tanque", String(columnaFaltante(PGRST204)));
  chk("42703 «of relation» → nombra la columna", columnaFaltante(E42703_REL) === "nivel_tanque");
  chk("42703 del SELECT «tabla.columna» → solo la columna", columnaFaltante(E42703_SEL) === "nivel_tanque");
  chk("un CHECK no es una columna faltante", columnaFaltante(CHECK) === null && !faltaColumna(CHECK));
  chk("un error vacío tampoco", columnaFaltante(null) === null && columnaFaltante(undefined) === null);
  chk("con el código y sin frase legible: falta UNA, sin nombre", columnaFaltante({ code: "PGRST204", message: "?" }) === "");
  chk("faltaColumna con nombre: solo si nombra ESA", faltaColumna(PGRST204, "nivel_tanque") && !faltaColumna(PGRST204, "fotos"));
  chk("faltaAlguna devuelve la de la lista que el error nombra", faltaAlguna(PGRST204, ["fotos", "nivel_tanque"] as const) === "nivel_tanque");
  chk("faltaAlguna no suelta una que no está en la lista", faltaAlguna(PGRST204, ["fotos"] as const) === null);
  chk("comillas dobles en la frase de PostgREST también", columnaFaltante({ message: 'Could not find the "km_salto_motivo" column of "combustible" in the schema cache' }) === "km_salto_motivo");

  // El reconocimiento VIEJO, copiado literal de lib/radar/acciones.ts (PR #70): tiene que reproducir el bug.
  const viejo = (error: { message: string }, payload: Record<string, unknown>) => {
    const msg = String(error.message ?? "");
    return ["fotos", "nivel_tanque"].find((c) => c in payload && msg.includes(c) && /does not exist/i.test(msg));
  };
  chk("REGRESIÓN: el respaldo viejo NO reconocía el PGRST204 (por eso se perdían las recargas)",
    viejo(PGRST204, { nivel_tanque: null }) === undefined);
  chk("…y sí el de Postgres, que en un INSERT no sale nunca", viejo(E42703_REL, { nivel_tanque: null }) === "nivel_tanque");
}

// ── 2. El guardado de radar_combustible con un PostgREST falso ───────────────
console.log("\n2. El guardado suelta la columna accesoria que el error nombra, y solo esa");
type Insercion = Record<string, unknown>;
function sbFalso(faltan: string[], otroError?: { code: string; message: string }) {
  const intentos: Insercion[] = [];
  const respuesta = (payload: Insercion) => {
    intentos.push(payload);
    if (otroError) return { data: null, error: otroError };
    const falta = faltan.find((c) => c in payload);
    if (falta) return { data: null, error: { code: "PGRST204", message: `Could not find the '${falta}' column of 'radar_combustible' in the schema cache` } };
    return { data: { id: "rc-1" }, error: null };
  };
  return {
    intentos,
    from: (_t: string) => ({
      insert: (payload: Insercion) => {
        const r = respuesta(payload);
        const thenable = Promise.resolve(r) as Promise<typeof r> & { select: () => { single: () => Promise<typeof r> } };
        thenable.select = () => ({ single: () => Promise.resolve(r) });
        return thenable;
      },
    }),
  };
}
const fila = { mensaje_id: "m1", placa: "CWZ-371", monto_total: 269.92, fotos: [], nivel_tanque: null, estado: "pendiente_revision" };
const intentar = async (sb: ReturnType<typeof sbFalso>, devolverId = false) => {
  try { return await insertarFilaRadar(sb, fila, devolverId); }
  catch (e) { return { data: null, quitadas: [] as never[], lanzo: (e as Error).message }; }
};
{
  const sb = sbFalso(["nivel_tanque"]);
  const r = await intentar(sb, true);
  chk("sin combustible-02: la carga SE GUARDA", r.data?.id === "rc-1");
  chk("soltando solo nivel_tanque", r.quitadas.join() === "nivel_tanque" && sb.intentos.length === 2 && "fotos" in sb.intentos[1]);
  chk("y el aviso nombra el SQL que falta", avisoColumnasQuitadas(r.quitadas).includes("combustible-02-nivel-tanque-radar.sql"));
}
{
  const sb = sbFalso(["fotos", "nivel_tanque"]);
  const r = await intentar(sb);
  chk("sin las dos migraciones: suelta las dos y guarda", r.quitadas.length === 2 && sb.intentos.length === 3);
}
{
  // `vehiculo_tercero_id` llega en el mismo SQL que `fotos`: en una instalación sin él, una carga de
  // tercero se guarda igual (con su placa) en vez de perderse entera.
  const sb = sbFalso(["fotos", "vehiculo_tercero_id"]);
  const r = await insertarFilaRadar(sb, { ...fila, vehiculo_tercero_id: 7 });
  chk("sin radar-ia-combustible-revision.sql: suelta fotos y vehiculo_tercero_id, guarda la placa",
    r.data?.id === "rc-1" && [...r.quitadas].sort().join() === "fotos,vehiculo_tercero_id" && sb.intentos[sb.intentos.length - 1].placa === "CWZ-371",
    r.quitadas.join());
  const aviso = avisoColumnasQuitadas(r.quitadas);
  chk("y el aviso nombra ese SQL UNA vez", aviso.split("radar-ia-combustible-revision.sql").length === 2, aviso);
}
{
  const sb = sbFalso([]);
  const r = await insertarFilaRadar(sb, fila);
  chk("con todo corrido: un solo intento, nada soltado, ningún aviso", sb.intentos.length === 1 && !r.quitadas.length && avisoColumnasQuitadas(r.quitadas) === "");
}
{
  const sb = sbFalso(["placa"]);
  let lanzo = "";
  try { await insertarFilaRadar(sb, fila); } catch (e) { lanzo = (e as Error).message; }
  chk("una columna que NO es accesoria nunca se suelta: el error sale tal cual", lanzo.includes("'placa' column") && sb.intentos.length === 1, lanzo);
}
{
  const sb = sbFalso([], CHECK);
  let lanzo = "";
  try { await insertarFilaRadar(sb, fila); } catch (e) { lanzo = (e as Error).message; }
  chk("un CHECK violado se dice con su texto, sin reintentos", lanzo.includes("check constraint") && sb.intentos.length === 1);
}

// ── 3. Una acción que falló es un ERROR ──────────────────────────────────────
console.log("\n3. El estado del mensaje después de su acción");
{
  chk("error_accion → error (nunca procesado)", estadoTrasAccion("error_accion") === "error");
  for (const a of ["combustible_registrado", "combustible_en_revision", "combustible_ya_registrado", "sin_accion", null, undefined]) {
    chk(`${String(a)} → procesado`, estadoTrasAccion(a as string | null) === "procesado");
  }
  const url = (new PostgrestClient("http://x/rest/v1").from("radar_mensajes").select("id").or(FILTRO_FALLIDOS) as any).url as URL;
  chk("la lista de fallidos pide error_accion O estado error",
    url.searchParams.get("or") === "(accion.eq.error_accion,estado.eq.error)", String(url.searchParams.get("or")));
  const url2 = (new PostgrestClient("http://x/rest/v1").from("radar_mensajes").select("id").in("resultado->>fusionado_en", ["a1", "b2"]) as any).url as URL;
  chk("las fotos fundidas se buscan por resultado->>fusionado_en, en todos los de la ráfaga",
    url2.searchParams.get("resultado->>fusionado_en") === "in.(a1,b2)", String(url2.searchParams.get("resultado->>fusionado_en")));
  const url3 = (new PostgrestClient("http://x/rest/v1").from("radar_mensajes").select("id").or(FILTRO_SIN_TERMINAR) as any).url as URL;
  chk("la ráfaga se busca entre lo fallido Y lo que sigue en la cola",
    url3.searchParams.get("or") === "(accion.eq.error_accion,estado.eq.error,estado.eq.pendiente)", String(url3.searchParams.get("or")));
  chk("esFallido ≡ FILTRO_FALLIDOS", esFallido({ estado: "error" }) && esFallido({ estado: "procesado", accion: "error_accion" }) &&
    !esFallido({ estado: "procesado", accion: "combustible_en_revision" }) && !esFallido({ estado: "pendiente" }));
  chk("sinTerminar: fallido o pendiente, nunca fundido ni tomado", sinTerminar({ estado: "pendiente" }) && sinTerminar({ estado: "error" }) &&
    !sinTerminar({ estado: "fusionado" }) && !sinTerminar({ estado: "procesando" }) && !sinTerminar({ estado: "descartado" }));

  // El aviso dice CUÁLES fallaron y por qué: el motivo sale de donde lo dejó el motor.
  chk("motivo: el error del pipeline", motivoDeFallo({ error: "La IA no devolvió un JSON reconocible", resultado: null }) === "La IA no devolvió un JSON reconocible");
  chk("motivo: el detalle de la ACCIÓN que falló (resultado.accion.detalle)",
    motivoDeFallo({ error: null, resultado: { extraccion: {}, accion: { accion: "error_accion", detalle: "PGRST204 nivel_tanque" } } }) === "PGRST204 nivel_tanque");
  chk("motivo: el error manda sobre el detalle", motivoDeFallo({ error: "x", resultado: { accion: { detalle: "y" } } }) === "x");
  chk("motivo: sin nada guardado se DICE, no sale vacío", /No quedó guardado/.test(motivoDeFallo({ error: "  ", resultado: {} })));
  // «Quitar del aviso» saca el mensaje de los fallidos y de lo que el lote vuelve a leer.
  for (const antes of [{ estado: "error", accion: null }, { estado: "procesado", accion: "error_accion" }]) {
    const despues = { ...antes, ...PATCH_QUITAR_DEL_AVISO };
    chk(`quitar del aviso (${antes.estado}/${antes.accion}): deja de ser fallido y de estar sin terminar`,
      esFallido(antes) && !esFallido(despues) && !sinTerminar(despues));
  }
}

// ── 4. La fecha del voucher contra la del mensaje ────────────────────────────
console.log("\n4. La fecha del voucher contra la fecha del mensaje");
{
  const ctv = revisarFechaVoucher({ leida: "2025-08-13", fechaMensaje: "2026-08-13" });
  chk("CTV-370: 13/08/2025 en un mensaje del 13/08/2026 → se corrige el AÑO", ctv.codigo === "corregida" && ctv.fecha === "2026-08-13", `${ctv.codigo} ${ctv.fecha}`);
  chk("…bloquea el auto-registro (lo confirma una persona)", ctv.anomalia?.bloquea === true && ctv.anomalia?.codigo === "fecha_corregida");
  chk("…y lo que leyó la IA viaja en la corrección", ctv.anomalia?.correccion?.campo === "fecha" && ctv.anomalia?.correccion?.leido === "2025-08-13");

  const swap = revisarFechaVoucher({ leida: "2026-03-10", fechaMensaje: "2026-10-06" });
  chk("03/10 leído como 10 de marzo → día y mes intercambiados", swap.codigo === "corregida" && swap.fecha === "2026-10-03", `${swap.codigo} ${swap.fecha}`);

  const enero = revisarFechaVoucher({ leida: "2026-12-31", fechaMensaje: "2026-01-02" });
  chk("31/12 del año anterior leído con el año del mensaje → se corrige al año anterior", enero.codigo === "corregida" && enero.fecha === "2025-12-31", `${enero.codigo} ${enero.fecha}`);

  const fut = revisarFechaVoucher({ leida: "2026-10-18", fechaMensaje: "2026-10-13" });
  chk("un dígito del día mal leído (18 por 13) → posterior al mensaje, NO se adivina", fut.codigo === "posterior_al_mensaje" && fut.fecha === "2026-10-18" && fut.anomalia?.bloquea === true);

  const vieja = revisarFechaVoucher({ leida: "2026-09-01", fechaMensaje: "2026-09-26" });
  chk("25 días antes del mensaje → a revisión, sin tocar la fecha", vieja.codigo === "muy_anterior" && vieja.fecha === "2026-09-01" && vieja.anomalia?.codigo === "fecha_fuera_de_rango");

  const ok = revisarFechaVoucher({ leida: "2026-10-03", fechaMensaje: "2026-10-04" });
  chk("el voucher de ayer mandado hoy → normal, sin anomalía", ok.codigo === "ok" && ok.fecha === "2026-10-03" && !ok.anomalia);

  const sin = revisarFechaVoucher({ leida: null, fechaMensaje: "2026-10-04" });
  chk("sin fecha leída → la del mensaje (como siempre), sin anomalía", sin.codigo === "sin_fecha" && sin.fecha === "2026-10-04" && !sin.anomalia);
  const inval = revisarFechaVoucher({ leida: "2026-04-31", fechaMensaje: "2026-05-02" });
  chk("una fecha que no existe (31/04) cuenta como no leída", inval.codigo === "sin_fecha" && inval.fecha === "2026-05-02");
  const ddmm = revisarFechaVoucher({ leida: "13/08/2026", fechaMensaje: "2026-08-13" });
  chk("un formato que no es ISO tampoco se escribe tal cual en la base", ddmm.codigo === "sin_fecha");
  const sinRef = revisarFechaVoucher({ leida: "2025-08-13", fechaMensaje: null });
  chk("sin fecha del mensaje no se juzga: se respeta la leída", sinRef.codigo === "sin_referencia" && sinRef.fecha === "2025-08-13" && !sinRef.anomalia);

  // Barrido: un año de lecturas alrededor de varios mensajes.
  let casos = 0, roto = 0, corregidas = 0, enRangoTocadas = 0;
  const base = Date.UTC(2026, 0, 1);
  for (const ref of ["2026-01-02", "2026-03-15", "2026-08-13", "2026-10-06", "2026-12-31"]) {
    for (let k = -400; k <= 400; k += 3) {
      const leida = new Date(Date.parse(ref + "T12:00:00Z") + k * 86_400_000).toISOString().slice(0, 10);
      const v = revisarFechaVoucher({ leida, fechaMensaje: ref });
      casos++;
      const a = atrasoDias(leida, ref);
      const enRango = a >= 0 && a <= MAX_ATRASO_DIAS;
      if (enRango && (v.codigo !== "ok" || v.fecha !== leida)) enRangoTocadas++;
      if (v.codigo === "corregida") {
        corregidas++;
        const ac = atrasoDias(v.fecha!, ref);
        if (!(ac >= 0 && ac <= MAX_ATRASO_DIAS) || v.fecha === leida || v.anomalia?.bloquea !== true) roto++;
      }
      if ((v.codigo === "posterior_al_mensaje") !== (!enRango && a < 0 && v.codigo !== "corregida")) roto++;
      if (v.codigo !== "ok" && v.codigo !== "sin_fecha" && v.codigo !== "sin_referencia" && !v.anomalia) roto++;
    }
  }
  void base;
  chk(`barrido (${casos}): una fecha en rango no se toca NUNCA`, enRangoTocadas === 0, String(enRangoTocadas));
  chk("toda corrección cae en rango, cambia la fecha y bloquea", roto === 0, String(roto));
  chk("y el barrido sí corrige (un motor que no corrigiera cumpliría lo de arriba)", corregidas > 0, String(corregidas));
}

// ── 5. ¿Ya está en /combustible? ─────────────────────────────────────────────
console.log("\n5. Lo que ya está en /combustible no se registra otra vez");
{
  // El caso del 03/10: voucher CWZ-371 por S/ 269.92 y su factura F882-0132184, emitida el 04/10,
  // que la registró sola mientras el Radar no guardaba nada.
  const deFactura: CargaRegistrada = {
    id: 901, fecha: "2026-10-04", total: 269.92, misma_unidad: true,
    observaciones: observacionCargaDeFactura("F882-0132184", null),
  };
  const r = buscarCargaRegistrada({ fecha: "2026-10-03", comprobante: null, monto: 269.92 }, [deFactura]);
  chk("CWZ-371: la carga que registró la FACTURA el día siguiente se reconoce", r?.por === "factura" && r.id === 901, r?.por ?? "—");

  // El chequeo VIEJO, copiado literal (misma fecha exacta): tiene que reproducir el hueco.
  const viejo = (fecha: string, monto: number, filas: { fecha: string; total: number }[]) =>
    filas.filter((x) => x.fecha === fecha).find((x) => Math.abs(Number(x.total || 0) - monto) < 1);
  chk("REGRESIÓN: con la fecha exacta el voucher del 03/10 NO veía la carga del 04/10",
    viejo("2026-10-03", 269.92, [{ fecha: "2026-10-04", total: 269.92 }]) === undefined);

  const delRadar: CargaRegistrada = { id: 902, fecha: "2026-10-04", total: 100, misma_unidad: true, observaciones: "Radar IA · grupo · ALEX · Comprobante V70S-00043100" };
  chk("una carga del Radar de AYER por el mismo importe NO es duplicado (el que carga S/ 100 todos los días)",
    buscarCargaRegistrada({ fecha: "2026-10-05", comprobante: "V70S-00043200", monto: 100 }, [delRadar]) === null);
  chk("la misma unidad, el mismo día, el mismo importe → duplicado (el chequeo de siempre)",
    buscarCargaRegistrada({ fecha: "2026-10-04", comprobante: null, monto: 100.4 }, [delRadar])?.por === "misma_fecha");
  chk("el mismo comprobante, aunque la carga esté a nombre de OTRA unidad → duplicado",
    buscarCargaRegistrada({ fecha: "2026-10-09", comprobante: "V70S-43100", monto: 55 }, [{ ...delRadar, misma_unidad: false }])?.por === "comprobante");
  chk("otra unidad, mismo día e importe, sin comprobante común → no es duplicado",
    buscarCargaRegistrada({ fecha: "2026-10-04", comprobante: null, monto: 100 }, [{ ...delRadar, misma_unidad: false }]) === null);
  chk("la factura de DOS días después ya no se toma por este despacho",
    buscarCargaRegistrada({ fecha: "2026-10-02", comprobante: null, monto: 269.92 }, [deFactura]) === null);
  chk("sin importe no se compara por día", buscarCargaRegistrada({ fecha: "2026-10-04", comprobante: null, monto: null }, [delRadar]) === null);

  chk("la nota se compara sin los ceros de relleno", comprobanteEnTexto("V70S-43064", "Nota V70S-00043064 · sin odómetro"));
  chk("y no confunde una nota con otra", !comprobanteEnTexto("V70S-00043064", "Comprobante V70S-00043065"));
  chk("un número corto no casa por casualidad", !comprobanteEnTexto("123", "Radar IA · 123 · ALEX"));
  chk("el patrón para la base busca los dígitos sin ceros", patronComprobante("V70S-00043064") === "%43064%" && patronComprobante("S/N") === null);
}

// ── 6. Reprocesar trae de vuelta SU ráfaga ───────────────────────────────────
console.log("\n6. Reprocesar un mensaje con su ráfaga, desde el más antiguo, sin perder nada");
{
  type Fila = MensajeRafaga;
  const VENTANA = 10 * 60_000;
  const t = (min: number) => new Date(Date.UTC(2026, 9, 4, 2, 55) + min * 60_000).toISOString();
  const ms = (f: Fila) => Date.parse(f.recibido_en);
  const WA = "51987654321@s.whatsapp.net";
  const msg = (id: string, min: number, estado: string, extra: Partial<Fila> = {}): Fila => ({
    id, estado, grupo_id: "g1", recibido_en: t(min), tipo: "imagen", texto: null, remitente_wa: WA, remitente_nombre: "ALEX", ...extra,
  });
  const fundido = (id: string, min: number, en: string, extra: Partial<Fila> = {}): Fila =>
    msg(id, min, "fusionado", { accion: "fusionado_en_otro_mensaje", resultado: { fusionado_en: en }, ...extra });
  const padreDe = (f: Fila) => String((f.resultado as { fusionado_en?: string } | null)?.fusionado_en ?? "");

  // MODELO del motor, copiado de lib/radar/motor.ts: `resolverCluster` (consulta por remitente_wa
  // tal cual + grupo, sin fusionados, ±ventana, pareceCombustible, miembrosDelMismoRemitente; manda
  // la más antigua, y una ya terminada no recibe hermanos) y el paso 4b (funde lo pendiente).
  const ACABADOS = new Set(["procesado", "descartado", "error"]);
  const resolver = (p: Fila, filas: Fila[]): { miembros: Fila[] } | { en: string } => {
    if (!pareceCombustible(p) || !remitenteUtilizable(p) || !p.grupo_id) return { miembros: [p] };
    const cands = miembrosDelMismoRemitente(p, filas.filter((f) =>
      f.remitente_wa === p.remitente_wa && f.grupo_id === p.grupo_id && f.estado !== "fusionado" &&
      Math.abs(ms(f) - ms(p)) <= VENTANA && pareceCombustible(f)));
    if (cands.length <= 1) return { miembros: [p] };
    cands.sort((a, b) => ms(a) - ms(b));
    if (cands[0].id === p.id) return { miembros: cands };
    if (ACABADOS.has(cands[0].estado)) return { miembros: [p] };
    return { en: cands[0].id };
  };
  /** `procesarPendientes({ soloMensajeId })` del modelo. */
  const procesar = (id: string, filas: Map<string, Fila>, lecturas: Map<string, string[]>) => {
    const f = filas.get(id)!;
    if (f.estado !== "pendiente") return; // el claim solo toma pendientes
    f.estado = "procesando";
    const r = resolver(f, [...filas.values()]);
    if ("en" in r) { f.estado = "fusionado"; f.resultado = { fusionado_en: r.en }; return; }
    lecturas.set(id, r.miembros.map((m) => m.id));
    for (const m of r.miembros) if (m.id !== id && m.estado === "pendiente") { m.estado = "fusionado"; m.resultado = { fusionado_en: id }; }
    f.estado = "procesado";
  };
  /** `reprocesarMensaje` del modelo: raíz → rafagaAReactivar → a pendiente → la primaria → lo que quede, en orden. */
  const reprocesar = (pulsado: string, base: Fila[], yaIntentadosHasta: string | null = null) => {
    const filas = new Map(base.map((f) => [f.id, { ...f }]));
    const p = filas.get(pulsado)!;
    const raiz = filas.get(raizDeReproceso(p)) ?? p;
    const plan = rafagaAReactivar(raiz, [...filas.values()].filter((f) => f.id !== raiz.id), VENTANA, { yaIntentadosHasta });
    for (const id of plan.ids) { const f = filas.get(id)!; if (f.estado !== "procesando") { f.estado = "pendiente"; f.accion = null; } }
    const lecturas = new Map<string, string[]>();
    procesar(plan.primaria, filas, lecturas);
    const quedan = plan.ids.map((id) => filas.get(id)!).filter((f) => f.estado === "pendiente").sort((a, b) => ms(a) - ms(b));
    for (const f of quedan) procesar(f.id, filas, lecturas);
    return { plan, filas, lecturas };
  };
  /** Perdido = sigue en la cola, o fundido en uno cuya lectura no lo incluyó (nadie lo va a leer). */
  const perdidos = (filas: Map<string, Fila>, lecturas: Map<string, string[]>, ids: string[]) =>
    ids.filter((id) => {
      const f = filas.get(id)!;
      if (f.estado === "pendiente") return true;
      return f.estado === "fusionado" && !(lecturas.get(padreDe(f)) ?? []).includes(id);
    });
  const lee = (r: { lecturas: Map<string, string[]> }, id: string) => [...(r.lecturas.get(id) ?? [])].sort().join();

  // A · La forma del 14/09 al 06/10: la principal quedó «procesado» con la acción caída y sus fotos
  //     fundidas en ella (el caso CWZ-371 del 03/10).
  {
    const base = [
      msg("X", 0, "procesado", { accion: "error_accion", tipo: "texto", texto: "CWZ-371 combustible" }),
      fundido("tablero", 1, "X"),
      fundido("nota", 2, "X"),
    ];
    const r = reprocesar("X", base);
    chk("A. vuelve la ráfaga entera: el caption, el tablero y la nota", [...r.plan.ids].sort().join() === "X,nota,tablero", r.plan.ids.join());
    chk("…y se lee en UNA extracción, la de su principal", lee(r, "X") === "X,nota,tablero", lee(r, "X"));
    chk("…sin perder nada", perdidos(r.filas, r.lecturas, r.plan.ids).length === 0);
    // Lo que hacía main: devolver a pendiente SOLO el pulsado y procesarlo.
    const filas = new Map(base.map((f) => [f.id, { ...f }]));
    filas.get("X")!.estado = "pendiente";
    const lect = new Map<string, string[]>();
    procesar("X", filas, lect);
    chk("REGRESIÓN: reprocesar solo el pulsado lo leía SIN la nota (fundida, la búsqueda la excluye)",
      !(lect.get("X") ?? []).includes("nota"), (lect.get("X") ?? []).join());
    const desdeNota = reprocesar("nota", base);
    chk("pulsar la NOTA (fundida) reprocesa la ráfaga desde su principal",
      desdeNota.plan.primaria === "X" && lee(desdeNota, "X") === "X,nota,tablero", lee(desdeNota, "X"));
  }

  // B · La forma del 30/09 al 02/10: todo en error, nada fundido, y se pulsa el del medio.
  {
    const base = [msg("Y", 0, "error", { tipo: "texto", texto: "placa CNQ-396 grifo" }), msg("X", 3, "error"), msg("N", 5, "error")];
    const r = reprocesar("X", base);
    chk("B. pulsado el del medio, se procesa desde el MÁS ANTIGUO", r.plan.primaria === "Y", r.plan.primaria);
    chk("…y la ráfaga entera entra a su extracción", lee(r, "Y") === "N,X,Y", lee(r, "Y"));
    chk("…sin perder nada", perdidos(r.filas, r.lecturas, r.plan.ids).length === 0);
    const filas = new Map(base.map((f) => [f.id, { ...f, estado: "pendiente" }]));
    procesar("X", filas, new Map());
    chk("REGRESIÓN: procesar el PULSADO lo funde en el más antiguo, que esta llamada no procesa",
      filas.get("X")!.estado === "fusionado" && filas.get("Y")!.estado === "pendiente");
  }

  // C · Un PENDIENTE más antiguo (el Radar apagado, la cola llena) también es parte de la ráfaga.
  {
    const r = reprocesar("X", [msg("P", 0, "pendiente"), msg("X", 4, "error")]);
    chk("C. un pendiente más antiguo entra y se procesa primero, con el reprocesado dentro",
      r.plan.primaria === "P" && lee(r, "P") === "P,X", `${r.plan.primaria} ${lee(r, "P")}`);
  }

  // D · Qué entra y qué no.
  {
    const base = [
      msg("X", 0, "error"),
      msg("conPalabras", 1, "error", { tipo: "texto", texto: "kilometraje 23980" }),
      msg("formaVieja", 2, "procesado", { accion: "error_accion" }),
      fundido("enConPalabras", 3, "conPalabras"),
      msg("otroConductor", 1, "error", { remitente_wa: "51911111111@s.whatsapp.net", remitente_nombre: "CERNA" }),
      msg("mismoNumeroOtroNombre", 1, "error", { remitente_nombre: "PEDRO" }),
      msg("otroJidGuardado", 1, "error", { remitente_wa: "51987654321:12@s.whatsapp.net" }),
      msg("otroGrupo", 1, "error", { grupo_id: "g2" }),
      msg("yaBien", 1, "procesado", { accion: "combustible_en_revision" }),
      msg("descartado", 1, "descartado", { accion: "sin_relevancia" }),
      msg("tomado", 1, "procesando"),
      msg("saludo", 1, "error", { tipo: "texto", texto: "buenos días" }),
      msg("lejos", 25, "error"),
      fundido("deOtraRafaga", 3, "Z"),
    ];
    const ids = new Set(reprocesar("X", base).plan.ids);
    const dentro = ["X", "conPalabras", "formaVieja", "enConPalabras"];
    chk("D. entran: un texto del rubro, la forma vieja del fallo y lo fundido en CUALQUIERA de la ráfaga",
      dentro.every((i) => ids.has(i)), [...ids].join());
    const fuera = ["otroConductor", "mismoNumeroOtroNombre", "otroJidGuardado", "otroGrupo", "yaBien", "descartado", "tomado", "saludo", "lejos", "deOtraRafaga"];
    chk("…y NO: otro conductor, el mismo número con otro nombre, otro jid guardado (el motor lo compara tal cual), otro grupo, lo ya terminado, lo tomado, un saludo, lo lejano ni lo fundido en otra ráfaga",
      !fuera.some((i) => ids.has(i)), fuera.filter((i) => ids.has(i)).join());
  }

  // E · El comodín: un remitente vacío no junta a nadie.
  {
    const base = [msg("X", 0, "error", { remitente_wa: "" }), fundido("nota", 2, "X", { remitente_wa: "" }), msg("vecino", 1, "error", { remitente_wa: "" })];
    const r = reprocesar("X", base);
    chk("E. un remitente vacío no junta a nadie sin terminar (solo lo fundido en él, que es un hecho)",
      [...r.plan.ids].sort().join() === "X,nota", r.plan.ids.join());
    chk("…y lo que se había fundido por el comodín se procesa por su cuenta, no se pierde",
      perdidos(r.filas, r.lecturas, r.plan.ids).length === 0 && lee(r, "nota") === "nota", lee(r, "nota"));
  }

  // F · Una ráfaga más larga que la ventana: cada foto a 8 min de la anterior.
  {
    const base = [msg("A", 0, "error"), msg("B", 8, "error"), msg("C", 16, "error"), msg("D", 24, "error")];
    const r = reprocesar("C", base);
    chk("F. una ráfaga ENCADENADA vuelve entera y se procesa desde la primera", r.plan.primaria === "A" && r.plan.ids.length === 4, r.plan.ids.join());
    chk("…y nada se queda en la cola ni perdido aunque el motor no la junte en una sola lectura",
      perdidos(r.filas, r.lecturas, r.plan.ids).length === 0, `A:${lee(r, "A")} C:${lee(r, "C")}`);
  }

  // G · El cursor del lote: lo fallido ya intentado en esta pasada no se paga otra vez.
  {
    const r = reprocesar("X", [msg("Y", 0, "error"), msg("X", 3, "error"), msg("P", 4, "pendiente")], t(0));
    chk("G. en lote, un fallido ya intentado en esta pasada no se reactiva arrastrado", !r.plan.ids.includes("Y") && r.plan.primaria === "X", r.plan.ids.join());
    chk("…pero lo pendiente sí entra: nadie lo intentó", r.plan.ids.includes("P"));
    chk("…y nada se pierde", perdidos(r.filas, r.lecturas, r.plan.ids).length === 0);
  }

  {
    const r = reprocesar("X", [msg("X", 0, "error")]);
    chk("H. sin nada alrededor, solo él", r.plan.ids.join() === "X" && r.plan.primaria === "X");
  }

  // Barrido: 4 mensajes de la misma persona en 0, 4, 9 y 15 min × 5 estados × imagen o saludo, más
  // dos ajenos (otro conductor, otro grupo), pulsando cada uno. 10 000 ráfagas × 4 = 40 000 reprocesos.
  {
    const MIN = [0, 4, 9, 15];
    const ESTADOS = ["error", "error_accion", "pendiente", "ok", "fusionado"] as const;
    let casos = 0, perdida = 0, enCola = 0, noAntigua = 0, partida = 0, ajenos = 0, unaLectura = 0, conRafaga = 0, perdidaMain = 0;
    for (let code = 0; code < 10 ** 4; code++) {
      const filas: Fila[] = [];
      let k = code;
      for (let i = 0; i < 4; i++) {
        const d = k % 10;
        k = Math.floor(k / 10);
        const est = ESTADOS[d % 5];
        const saludo = d >= 5 && est !== "fusionado" ? { tipo: "texto", texto: "ok gracias" } : {};
        const id = `m${i}`;
        if (est === "fusionado") {
          // Se funde en el anterior más cercano que el motor pudo tomar como principal.
          const padre = [...filas].reverse().find((f) => f.estado !== "fusionado" && pareceCombustible(f) && Date.parse(t(MIN[i])) - ms(f) <= VENTANA);
          filas.push(padre ? fundido(id, MIN[i], padre.id) : msg(id, MIN[i], "error"));
        } else if (est === "error_accion") filas.push(msg(id, MIN[i], "procesado", { accion: "error_accion", ...saludo }));
        else if (est === "ok") filas.push(msg(id, MIN[i], "procesado", { accion: "combustible_en_revision", ...saludo }));
        else filas.push(msg(id, MIN[i], est, saludo));
      }
      filas.push(msg("ajenoConductor", 2, "error", { remitente_wa: "51911111111@s.whatsapp.net", remitente_nombre: "CERNA" }));
      filas.push(msg("ajenoGrupo", 3, "error", { grupo_id: "g2" }));

      for (const pulsado of ["m0", "m1", "m2", "m3"]) {
        casos++;
        const r = reprocesar(pulsado, filas);
        if (perdidos(r.filas, r.lecturas, r.plan.ids).length) perdida++;
        if (r.plan.ids.some((id) => r.filas.get(id)!.estado === "pendiente")) enCola++;
        if (r.filas.get("ajenoConductor")!.estado !== "error" || r.filas.get("ajenoGrupo")!.estado !== "error") ajenos++;
        const tp = ms(r.filas.get(r.plan.primaria)!);
        if (r.plan.ids.some((id) => ms(r.filas.get(id)!) < tp)) noAntigua++;
        // Una ráfaga que cabe en la ventana de su primaria, sin nada terminado más viejo al lado, se lee de UNA vez.
        const caben = r.plan.ids.every((id) => ms(r.filas.get(id)!) - tp <= VENTANA && pareceCombustible(r.filas.get(id)!));
        const bloquea = filas.some((f) => !r.plan.ids.includes(f.id) && f.estado !== "fusionado" && pareceCombustible(f) &&
          f.grupo_id === "g1" && f.remitente_wa === WA && ms(f) < tp && tp - ms(f) <= VENTANA);
        if (caben && !bloquea) {
          const l = new Set(r.lecturas.get(r.plan.primaria) ?? []);
          if (r.plan.ids.every((id) => l.has(id))) { unaLectura++; if (l.size > 1) conRafaga++; } else partida++;
        }
        // Lo que hacía main: solo el pulsado a pendiente, y procesarlo.
        const fm = new Map(filas.map((f) => [f.id, { ...f }]));
        fm.get(pulsado)!.estado = "pendiente";
        const lm = new Map<string, string[]>();
        procesar(pulsado, fm, lm);
        const leidoMain = lm.get(pulsado) ?? [];
        const fundidoSinLeer = filas.some((f) => f.estado === "fusionado" && padreDe(f) === pulsado && !leidoMain.includes(f.id));
        const tragado = fm.get(pulsado)!.estado === "fusionado" && fm.get(padreDe(fm.get(pulsado)!))?.estado === "pendiente";
        if (fundidoSinLeer || tragado) perdidaMain++;
      }
    }
    chk(`barrido (${casos}): ningún reproceso pierde un mensaje de su ráfaga`, perdida === 0, String(perdida));
    chk("…ni deja nada en la cola esperando al cron", enCola === 0, String(enCola));
    chk("…ni toca a otro conductor ni a otro grupo", ajenos === 0, String(ajenos));
    chk("…y siempre arranca por el más antiguo de lo reactivado", noAntigua === 0, String(noAntigua));
    chk("una ráfaga que cabe en la ventana se lee en UNA sola extracción", partida === 0, `${partida} partidas · ${unaLectura} de una vez`);
    chk("y el barrido sí junta ráfagas (un motor que nunca juntara cumpliría lo de arriba)", conRafaga > 0, String(conRafaga));
    chk("REGRESIÓN: lo de main (solo el pulsado) pierde o deja sin leer parte de la ráfaga", perdidaMain > 0, String(perdidaMain));
  }
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
