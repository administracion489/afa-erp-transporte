"use client";
// app/combustible/FacturasCorreo.tsx — Pestaña «📧 Facturas»: lo que llegó al correo y qué
// hizo el ERP con cada línea (lib/combustible/factura-lineas.ts declara los códigos).
// Lo que quedó en «Revisar» se confirma aquí con un clic, eligiendo placa y fecha; lo que la
// lectura del último año dejó por registrar, todo junto, viendo antes cuántas cargas son y por
// cuánto.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import {
  ETIQUETA_LINEA, FILTRO_HISTORICO, DIAS_REGISTRO_AUTOMATICO, resumenHistorico,
  type LineaFactura, type PlanLinea, type ResumenHistorico,
} from "@/lib/combustible/factura-lineas";
import type { CodigoConexion } from "@/lib/combustible/correo-conexion";
import {
  sumarDias, generadaDespues, diaLima,
  type CargaPorMover, type DesfaseCuenta as DecisionDeCuenta, type ResumenMover,
} from "@/lib/combustible/desfase-factura";
import type { TipoPorCorregir } from "@/lib/combustible/tipo-desde-factura";
import { configCombustible } from "@/lib/combustible-tipos";
import { avisoOrdenEnFacturas, pendientesCerca, type RecargaPorRevisar } from "@/lib/combustible/orden-revision";
import { avisoSaludEnFacturas, type SaludRadar } from "@/lib/radar/salud";
import { leerSaludRadar } from "@/lib/radar/salud-datos";
import CorreoFacturas from "./CorreoFacturas";
import CargasPorCompletar from "./CargasPorCompletar";
import { BotonesFactura } from "@/components/combustible/FacturaDelCorreo";

const S = (n: number | null | undefined) =>
  n == null ? "—" : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

// Un año de facturas son unas 200 filas: se traen todas, para que los conteos de arriba digan
// lo mismo que la tabla.
const LIMITE = 500;

const ESTADO: Record<string, [string, string]> = {
  conciliada:     ["Conciliada", "#15803d"],
  parcial:        ["Con pendientes", "#b45309"],
  procesada:      ["Leída", "#1d4ed8"],
  con_diferencia: ["Sin líneas legibles", "#b91c1c"],
  // No es un error: casi siempre es un correo que no trae una factura (una carta, un estado de cuenta).
  sin_adjunto:    ["Sin factura adjunta", "#6b7280"],
  error:          ["Error", "#b91c1c"],
  descartada:     ["Descartada", "#9ca3af"],
  pendiente:      ["Pendiente", "#6b7280"],
};

type Deuda = { id: number; serie: string | null; numero: string | null; fecha_emision: string | null; total: number };
type DesfaseCuenta = { cuenta_id: number; nombre: string; decision: DecisionDeCuenta; por_mover: ResumenMover; lista: CargaPorMover[] };

async function post(body: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/combustible/facturas", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false, error: `Error ${r.status}` }));
}
const suma = (xs: any[], k: string) => xs.reduce((a, x) => a + (Number(x?.[k]) || 0), 0);

export default function FacturasCorreo() {
  const [filas, setFilas] = useState<any[] | null>(null);
  const [placas, setPlacas] = useState<string[]>([]);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [sync, setSync] = useState<string | null>(null);
  const [cargando, setCargando] = useState<"" | "normal" | "historial" | "reintento">("");
  const [elec, setElec] = useState<Record<string, { placa: string; fecha: string }>>({});
  // De qué buzón se lee (lo resuelve CorreoFacturas). Sin uno legible, «Leer correo ahora» no
  // tiene a quién preguntar: el botón se apaga y DICE por qué en vez de fallar al pulsarlo.
  const [codigoCorreo, setCodigoCorreo] = useState<CodigoConexion | null>(null);
  const sinCorreo = codigoCorreo === "ninguna" || codigoCorreo === "rota";
  // Lo que el historial dejó por registrar (resumenHistorico) y el botón que lo registra.
  const [hist, setHist] = useState<ResumenHistorico | null>(null);
  const [registrando, setRegistrando] = useState(false);
  const [msgHist, setMsgHist] = useState<string | null>(null);
  // Comprobantes de la cuenta prepago que nacieron como deuda antes de este arreglo.
  const [deuda, setDeuda] = useState<{ docs: Deuda[]; total: number } | null>(null);
  const [marcando, setMarcando] = useState(false);
  const [msgDeuda, setMsgDeuda] = useState<string | null>(null);
  // Cuántos días después del despacho sale la factura (medido o configurado), y las cargas que una
  // factura registró con la fecha de EMISIÓN (lib/combustible/desfase-factura.ts).
  const [desf, setDesf] = useState<DesfaseCuenta[] | null>(null);
  const [moviendo, setMoviendo] = useState(false);
  const [msgDesf, setMsgDesf] = useState<string | null>(null);
  // EL ORDEN DE TRABAJO: primero el Radar, después las facturas (lib/combustible/orden-revision.ts).
  // Las recargas del Radar que siguen por revisar; null = no se pudieron leer (no se afirma nada).
  const [pendRadar, setPendRadar] = useState<RecargaPorRevisar[] | null>(null);
  // ¿El Radar está leyendo? (lib/radar/salud.ts). Si no, las cargas de la cuenta entran por aquí sin
  // odómetro, y lo primero que hay que saber es por qué. null = no se sabe (y no se dice nada).
  const [salud, setSalud] = useState<SaludRadar | null>(null);
  // Cuántas cargas registradas desde la factura esperan su odómetro y su fecha (CargasPorCompletar).
  const [porCompletar, setPorCompletar] = useState<number | null>(null);

  const cargar = useCallback(async () => {
    const [{ data, error }, { data: otras }, { data: hs, error: eHist }] = await Promise.all([
      supabase.from("radar_facturas").select("*")
        .not("lineas", "is", null).order("recibido_en", { ascending: false }).limit(LIMITE),
      supabase.from("radar_facturas").select("*")
        .in("estado", ["sin_adjunto", "error"]).order("recibido_en", { ascending: false }).limit(100),
      // El MISMO filtro con el que el botón las registra (FILTRO_HISTORICO): lo que se promete en
      // el resumen es exactamente lo que se registra.
      supabase.from("radar_facturas").select("id, lineas, conciliacion")
        .in("estado", [...FILTRO_HISTORICO.estados]).contains("conciliacion", FILTRO_HISTORICO.conciliacion).limit(1000),
    ]);
    if (error) { setFilas([]); setSync(/lineas/.test(error.message) ? "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql." : error.message); return; }
    const todas = [...((data as any[]) ?? []), ...((otras as any[]) ?? []).filter((o) => !((data as any[]) ?? []).some((d) => d.id === o.id))];
    todas.sort((a, b) => String(b.recibido_en).localeCompare(String(a.recibido_en)));
    setFilas(todas);
    setHist(eHist ? null : resumenHistorico((hs as any[]) ?? []));
  }, []);

  const cargarDeuda = useCallback(async () => {
    try {
      const j = await post({ accion: "deuda_prepago" });
      setDeuda(j?.ok ? { docs: j.docs ?? [], total: Number(j.total ?? 0) } : null);
    } catch { setDeuda(null); } // es un aviso aparte: si falla, el resto de la pestaña sirve igual
  }, []);

  const cargarDesfase = useCallback(async () => {
    try {
      const j = await post({ accion: "desfase" });
      setDesf(j?.ok ? (j.cuentas ?? []) : null);
    } catch { setDesf(null); } // es un aviso aparte: si falla, el resto de la pestaña sirve igual
  }, []);

  /** TODAS las recargas del Radar por revisar, paginadas: el conteo del aviso no puede quedarse corto. */
  const cargarPendRadar = useCallback(async () => {
    const out: RecargaPorRevisar[] = [];
    for (let desde = 0; desde < 20_000; desde += 1000) {
      const { data, error } = await supabase.from("radar_combustible").select("id, placa, fecha, monto_total")
        .eq("estado", "pendiente_revision").order("created_at", { ascending: false }).range(desde, desde + 999);
      if (error) { setPendRadar(null); return; } // es un aviso aparte: sin él, la pestaña sirve igual
      type Fila = { id: string | number; placa: string | null; fecha: string | null; monto_total: number | string | null };
      out.push(...((data as Fila[] | null) ?? []).map((r) => ({
        id: String(r.id), placa: r.placa ?? null,
        fecha: r.fecha ? String(r.fecha).slice(0, 10) : null, monto: r.monto_total == null ? null : Number(r.monto_total),
      })));
      if (!data || data.length < 1000) break;
    }
    setPendRadar(out);
  }, []);

  // AL ABRIR, LAS FACTURAS PENDIENTES SE VUELVEN A CRUZAR con lo registrado hoy (sin leer el
  // correo). Sin esto, una carga tecleada a mano en Combustible que ES una línea de la factura
  // seguía como «Esperando al Radar» hasta el próximo ciclo del correo, con un botón que invita a
  // registrarla otra vez. Best-effort: si falla, la pantalla enseña lo guardado.
  // Cargas rotuladas con otro combustible que su factura (lib/combustible/tipo-desde-factura.ts).
  const [tipos, setTipos] = useState<TipoPorCorregir[] | null>(null);
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [msgTipos, setMsgTipos] = useState<string | null>(null);
  const cargarTipos = useCallback(async () => {
    const j = await post({ accion: "tipos_distintos" }).catch(() => null);
    setTipos(j?.ok ? (j.lista as TipoPorCorregir[]) : null); // si falla, no se afirma nada
  }, []);
  async function corregirTipos(lista: TipoPorCorregir[]) {
    const etq = (t: string | null) => (t ? configCombustible(t).label : "sin tipo");
    if (!confirm(
      `Corregir el combustible de ${lista.length} carga(s) según su factura:\n\n` +
      lista.slice(0, 12).map((x) => `• ${x.placa ?? "—"} ${x.fecha} · ${S(x.total)}: ${etq(x.tipo_carga)} → ${etq(x.tipo_factura)}`).join("\n") +
      (lista.length > 12 ? `\n… y ${lista.length - 12} más` : "") +
      `\n\nNo cambia importes, galones ni fechas: solo el tipo (y su unidad). La carga pasa a contar en la serie de ese combustible.`
    )) return;
    setCorrigiendo(true); setMsgTipos(null);
    const j = await post({ accion: "corregir_tipos", ids: lista.map((x) => x.carga_id) });
    setMsgTipos(j.ok ? `${j.corregidas} carga(s) corregidas según su factura.` : `No se pudo: ${j.error}`);
    setCorrigiendo(false);
    cargarTipos();
  }

  const [cruzando, setCruzando] = useState(true);
  useEffect(() => {
    let vivo = true;
    post({ accion: "reconciliar" }).then((j) => {
      if (!vivo || !j?.ok) return;
      const enl = Number(j.enlazadas) || 0, reg = Number(j.registradas) || 0;
      if (enl || reg) {
        setSync(
          (enl ? `${enl} línea(s) de factura se enlazaron con cargas que ya estaban registradas (no se creó ninguna otra). ` : "") +
          (reg ? `${reg} carga(s) que faltaban se registraron desde la factura.` : ""),
        );
      }
      if (Number(j.reconciliadas) > 0) cargar();
    }).catch(() => {}).finally(() => { if (vivo) { setCruzando(false); cargarTipos(); } });
    return () => { vivo = false; };
  }, [cargar, cargarTipos]);

  useEffect(() => {
    cargar();
    cargarDeuda();
    cargarDesfase();
    cargarPendRadar();
    leerSaludRadar(supabase).then(setSalud).catch(() => setSalud(null)); // un aviso aparte: si falla, no se afirma nada
    Promise.all([supabase.from("vehiculos").select("placa"), supabase.from("vehiculos_tercero").select("placa")]).then(([a, b]) => {
      setPlacas([...((a.data as any[]) ?? []), ...((b.data as any[]) ?? [])].map((r) => String(r.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean).sort());
    });
  }, [cargar, cargarDeuda, cargarDesfase, cargarPendRadar]);

  async function sincronizar() {
    setCargando("normal"); setSync("Buscando facturas en el correo…");
    try {
      const j = await post({ accion: "sincronizar" });
      if (!j.ok) setSync(`No se pudo: ${j.error}`);
      else {
        const rs: any[] = j.resultados ?? [];
        const buzon = rs.map((x) => x.correo?.email).find(Boolean);
        const pend = suma(rs, "pendientes"), ia = suma(rs, "con_ia"), hs = suma(rs, "historicas");
        setSync(
          `${buzon ? `${buzon}: ` : ""}${suma(rs, "correos_vistos")} correo(s) coinciden con el filtro · ${suma(rs, "nuevas")} factura(s) nuevas · ` +
          `${suma(rs, "registradas")} carga(s) registradas desde la factura · ${suma(rs, "por_revisar")} línea(s) para revisar.` +
          (hs ? ` ${hs} del historial esperan tu decisión (abajo).` : "") +
          (ia ? ` ${ia} leída(s) del PDF con IA.` : "") +
          (pend ? ` Quedan ${pend} correo(s) por leer: se leen en el próximo ciclo, o vuelve a pulsar.` : ""),
        );
      }
    } catch (e: any) { setSync(e.message); }
    setCargando("");
    cargar();
    cargarDesfase();
  }

  /** «Leer el último año»: el servidor lee por tandas (LECTURA_HISTORIAL) y la pantalla vuelve a
   *  llamar mientras queden correos y la cola avance. Lo ya leído queda guardado tanda por tanda:
   *  cortar a la mitad no pierde nada, se sigue con el mismo botón. */
  async function leerHistorial() {
    setCargando("historial"); setSync("📚 Buscando las facturas del último año…");
    const t = { nuevas: 0, reg: 0, hist: 0, ia: 0, err: 0 };
    let previo = Number.POSITIVE_INFINITY, cierre = "", buzon: string | undefined;
    try {
      for (let tanda = 1; tanda <= 40; tanda++) {
        const j = await post({ accion: "sincronizar", historial: true });
        if (!j.ok) { cierre = `Se detuvo: ${j.error ?? "error"}. Lo ya leído quedó guardado; vuelve a pulsar para seguir.`; break; }
        const rs: any[] = j.resultados ?? [];
        buzon = rs.map((x) => x.correo?.email).find(Boolean) ?? buzon;
        const vistos = suma(rs, "correos_vistos"), pend = suma(rs, "pendientes");
        t.nuevas += suma(rs, "nuevas"); t.reg += suma(rs, "registradas"); t.hist += suma(rs, "historicas"); t.ia += suma(rs, "con_ia");
        t.err += rs.reduce((a, x) => a + ((x.detalle ?? []) as any[]).filter((d) => d.estado === "error").length, 0);
        setSync(`📚 Leyendo el último año${buzon ? ` de ${buzon}` : ""}… ${vistos - pend} de ${vistos} correo(s) revisados.`);
        await cargar();
        if (pend === 0) { cierre = `📚 Último año leído${buzon ? ` (${buzon})` : ""}: ${vistos} correo(s) revisados.`; break; }
        if (pend >= previo) { cierre = `Se detuvo con ${pend} correo(s) sin leer porque no avanzaba. Lo ya leído quedó guardado; vuelve a pulsar en un rato.`; break; }
        previo = pend;
      }
    } catch (e: any) { cierre = `Se detuvo: ${e.message}. Lo ya leído quedó guardado; vuelve a pulsar para seguir.`; }
    setSync(
      `${cierre} ${t.nuevas} factura(s) leídas en esta pasada · ${t.reg} carga(s) recientes registradas desde la factura.` +
      (t.hist ? ` ${t.hist} carga(s) de hace más de ${DIAS_REGISTRO_AUTOMATICO} días no están en el ERP: esperan tu decisión (abajo).` : "") +
      (t.ia ? ` ${t.ia} leída(s) del PDF con IA.` : "") +
      (t.err ? ` ${t.err} correo(s) con error: se reintentan solos.` : ""),
    );
    setCargando("");
    cargar();
    cargarDesfase();
  }

  /** «Registrar las del historial»: una persona vio cuántas son y por cuánto. El servidor
   *  re-concilia cada factura (si una carga apareció mientras tanto, se enlaza y no se duplica). */
  async function registrarHistorial() {
    const h = hist;
    if (!h?.lineas) return;
    if (!confirm(
      `¿Registrar ${h.lineas} carga(s) de combustible del historial, por ${S(h.total)}, del ${F(h.desde)} al ${F(h.hasta)}?\n\n` +
      "• Entran SIN odómetro: la factura no lo trae.\n" +
      "• Se suman a los gastos de esos meses en Finanzas. Si ese combustible ya lo anotaste por otro lado (un gasto, una caja chica), se contaría dos veces: en ese caso, revísalas una por una abajo.\n" +
      "• Si alguna ya apareció en el ERP, se enlaza a su factura y no se duplica.",
    )) return;
    setRegistrando(true); setMsgHist("Registrando…");
    const t = { reg: 0, fact: 0, ocupadas: 0, errores: [] as string[] };
    let previo = Number.POSITIVE_INFINITY;
    try {
      for (let tanda = 1; tanda <= 30; tanda++) {
        const j = await post({ accion: "registrar_historicas" });
        if (!j.ok) { t.errores.push(j.error ?? "error"); break; }
        t.reg += Number(j.registradas) || 0; t.fact += Number(j.facturas) || 0;
        t.ocupadas = Number(j.ocupadas) || 0; // las ocupadas se vuelven a intentar en la tanda siguiente
        t.errores.push(...((j.errores ?? []) as string[]));
        setMsgHist(`Registrando… ${t.reg} carga(s) registradas.`);
        const quedan = Number(j.quedan) || 0;
        if (!quedan || quedan >= previo) break;
        previo = quedan;
      }
    } catch (e: any) { t.errores.push(e.message); }
    setMsgHist(
      `${t.reg} carga(s) registradas desde ${t.fact} factura(s).` +
      (t.ocupadas ? ` ${t.ocupadas} factura(s) se estaban procesando en ese momento: vuelve a pulsar en un minuto.` : "") +
      (t.errores.length ? ` No se pudo con ${t.errores.length}: ${t.errores.slice(0, 3).join(" · ")}` : ""),
    );
    setRegistrando(false);
    cargar();
    cargarDesfase();
  }

  /** «Reintentar los que fallaron»: cada correo en «Error» se vuelve a leer UNA vez por pulsación
   *  (el servidor avanza por id). Los que siguen fallando quedan con su motivo en la fila. */
  async function reintentarErrores() {
    setCargando("reintento"); setSync("🔁 Volviendo a leer los correos que fallaron…");
    const t = { reintentados: 0, resueltos: 0, siguen: 0, motivos: [] as string[] };
    let desde = 0, cierre = "";
    try {
      for (let tanda = 1; tanda <= 30; tanda++) {
        const j = await post({ accion: "reintentar_errores", desde_id: desde });
        if (!j.ok) { cierre = `Se detuvo: ${j.error ?? "error"}.`; break; }
        t.reintentados += Number(j.reintentados) || 0; t.resueltos += Number(j.resueltos) || 0; t.siguen += Number(j.siguen) || 0;
        for (const m of (j.motivos ?? []) as string[]) if (!t.motivos.includes(m)) t.motivos.push(m);
        setSync(`🔁 Reintentando… ${t.reintentados} correo(s): ${t.resueltos} leídos bien, ${t.siguen} siguen fallando.`);
        await cargar();
        if (!j.quedan || !j.reintentados || j.ultimo_id == null) break;
        desde = Number(j.ultimo_id);
      }
    } catch (e: any) { cierre = `Se detuvo: ${e.message}.`; }
    setSync(
      `${cierre ? `${cierre} ` : ""}${t.reintentados} correo(s) vueltos a leer: ${t.resueltos} bien, ${t.siguen} siguen fallando.` +
      (t.motivos.length ? ` Motivo: ${t.motivos.slice(0, 2).join(" · ")}` : ""),
    );
    setCargando("");
    cargar();
  }

  /** «Moverlas a la fecha del despacho»: una persona vio cuáles, de qué fecha a cuál y cuántas cambian
   *  de mes. El servidor recalcula la lista y no mueve nada si el desfase cambió entre tanto. */
  async function moverADespacho(c: DesfaseCuenta) {
    const r = c.por_mover;
    if (!r.cargas) return;
    const ej = c.lista.slice(0, 5).map((x) => `${x.placa ?? "—"} ${F(x.desde)} → ${F(x.hacia)} (${S(x.total)})`).join("\n");
    if (!confirm(
      `¿Mover ${r.cargas} carga(s) de combustible de ${c.nombre} a la fecha del despacho, ${c.decision.dias} día(s) antes de su factura?\n\n${ej}${r.cargas > 5 ? `\n… y ${r.cargas - 5} más` : ""}\n\n` +
      `• Las registró la factura del correo con su fecha de EMISIÓN, porque la factura no trae la del despacho.\n` +
      (r.cruzan_mes ? `• ${r.cruzan_mes} pasan al MES ANTERIOR: cambia el gasto de ese mes en Finanzas.\n` : "") +
      `• Cada una queda con una nota que dice de qué fecha se movió. Una que alguien ya cambió de fecha no se toca.`,
    )) return;
    setMoviendo(true); setMsgDesf(null);
    const j = await post({ accion: "mover_a_despacho", ids: c.lista.map((x) => x.combustible_id), dias: c.decision.dias });
    setMsgDesf(j.ok
      ? `${j.movidas} carga(s) movidas a la fecha del despacho (${S(j.total)})${j.cruzan_mes ? `; ${j.cruzan_mes} pasaron al mes anterior` : ""}.`
      : `No se pudo: ${j.error}`);
    setMoviendo(false);
    cargarDesfase();
    cargar();
  }

  async function marcarPagadas() {
    if (!deuda?.docs.length) return;
    const n = deuda.docs.length;
    const ej = deuda.docs.slice(0, 6).map((d) => `${d.serie ?? ""}-${d.numero ?? ""} (${S(d.total)})`).join(", ");
    if (!confirm(
      `¿Marcar como PAGADOS ${n} comprobante(s) de combustible, por ${S(deuda.total)}?\n\n${ej}${n > 6 ? ` y ${n - 6} más` : ""}\n\n` +
      "Son facturas de una cuenta prepago: se pagaron con el saldo que se depositó antes. Hoy figuran como deuda en Tesorería y podrían entrar a un lote de pago: el mismo combustible pagado dos veces.\n" +
      "No se toca ninguno con un pago aplicado, un anticipo anotado o dentro de un lote.",
    )) return;
    setMarcando(true); setMsgDeuda(null);
    const j = await post({ accion: "marcar_prepago", ids: deuda.docs.map((d) => d.id) });
    setMsgDeuda(j.ok ? `${j.marcadas} comprobante(s) quedaron pagados (${S(j.total)}): ya no figuran como deuda en Tesorería.` : `No se pudo: ${j.error}`);
    setMarcando(false);
    cargarDeuda();
  }

  // Las líneas de UNA factura se registran EN FILA: cada confirmación reconcilia la factura entera
  // y el servidor la reclama con un candado, así que dos clics seguidos sobre la misma factura
  // chocaban («otra conciliación de esta factura está en curso»). Aquí el segundo clic espera a
  // que termine el primero, y si el candado lo tiene otro (el cron), se reintenta solo unas veces.
  const colaFactura = useRef(new Map<number, Promise<void>>());
  const [enCurso, setEnCurso] = useState<Record<string, "espera" | "registrando">>({});
  function confirmar(f: any, n: number, e: { placa: string; fecha: string }) {
    const k = `${f.id}-${n}`;
    if (enCurso[k]) return;
    setEnCurso((m) => ({ ...m, [k]: "espera" }));
    const previa = colaFactura.current.get(f.id) ?? Promise.resolve();
    const esta = previa.then(async () => {
      setEnCurso((m) => ({ ...m, [k]: "registrando" }));
      try {
        let j: { ok?: boolean; error?: string; linea?: { detalle?: string; codigo?: string; casa_con?: number | string } } | null = null;
        for (let intento = 0; intento < 5; intento++) {
          j = await post({ accion: "confirmar_linea", factura_id: f.id, n, placa: e.placa || null, fecha: e.fecha || null });
          if (j?.ok || !/en curso/i.test(String(j?.error ?? ""))) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
        if (!j?.ok) alert(j?.linea?.detalle ?? j?.error ?? "No se pudo registrar");
        // La confirmación cruza primero con lo registrado: si la carga YA estaba (tecleada a mano o
        // por el Radar), se enlaza y no se crea otra. Se dice, para que nadie la busque duplicada.
        else if (j?.linea?.codigo === "ya_registrada") {
          alert(`No se creó otra carga: ya estaba registrada (carga #${j.linea.casa_con ?? "?"}). Quedó enlazada a esta factura.`);
        }
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : "No se pudo registrar");
      } finally {
        setEnCurso((m) => { const c = { ...m }; delete c[k]; return c; });
        cargar();
      }
    });
    colaFactura.current.set(f.id, esta);
  }

  async function descartar(f: any) {
    if (!confirm("¿Descartar este correo? No es una factura de combustible y no se volverá a mirar.")) return;
    await post({ accion: "descartar", factura_id: f.id });
    cargar();
  }

  const resumen = useMemo(() => {
    const planes = (filas ?? []).flatMap((f) => (Array.isArray(f.conciliacion) ? f.conciliacion : []) as PlanLinea[]);
    const c = (k: string) => planes.filter((p) => p.codigo === k).length;
    const hs = planes.filter((p) => p.codigo === "revisar" && p.motivo === "historico").length;
    // Solo los errores de esta pestaña (llevan cuenta): la bandeja de Contabilidad usa la misma tabla.
    const errores = (filas ?? []).filter((f) => f.estado === "error" && f.cuenta_id != null).length;
    return { reg: c("registrar"), ya: c("ya_registrada"), rev: c("revisar") - hs, hist: hs, radar: c("en_radar_pendiente"), esp: c("en_espera"), errores };
  }, [filas]);

  const avisoOrden = avisoOrdenEnFacturas({ pendientesRadar: pendRadar ? pendRadar.length : null, lineasEsperando: resumen.radar });
  const avisoSalud = avisoSaludEnFacturas(salud);

  return (
    <section className="space-y-3">
      {/* SI EL RADAR NO ESTÁ LEYENDO, antes que nada: es la razón de que las cargas entren por aquí sin
          odómetro, y lo único que lo arregla de verdad está en otra pantalla (lib/radar/salud.ts). */}
      {avisoSalud && (
        <div className="rounded-xl border p-4"
          style={avisoSalud.tono === "grave" ? { background: "#fef2f2", borderColor: "#fca5a5" } : { background: "#fffbeb", borderColor: "#fcd34d" }}>
          <div className={`text-sm font-bold ${avisoSalud.tono === "grave" ? "text-red-800" : "text-amber-900"}`}>
            {avisoSalud.tono === "grave" ? "⛔ " : "⚠ "}{avisoSalud.titulo}
          </div>
          <div className={`text-xs mt-1 ${avisoSalud.tono === "grave" ? "text-red-800" : "text-amber-900"}`}>{avisoSalud.detalle}</div>
          <Link href="/radar-ia" className="inline-block mt-2 px-4 py-2 rounded-lg text-sm font-bold text-white" style={{ background: avisoSalud.tono === "grave" ? "#b91c1c" : "#b45309" }}>
            Ir a Radar IA
          </Link>
        </div>
      )}
      {/* EL ORDEN DE TRABAJO, arriba de todo: lo primero que hay que saber al entrar a esta pestaña es si
          el Radar ya está al día. Si no, lo de aquí abajo todavía va a cambiar solo. */}
      {avisoOrden && (
        <div className="rounded-xl border p-4"
          style={avisoOrden.tono === "pendiente" ? { background: "#eff6ff", borderColor: "#93c5fd" } : { background: "#f0fdf4", borderColor: "#bbf7d0" }}>
          <div className={`text-sm font-bold ${avisoOrden.tono === "pendiente" ? "text-[#1e3a8a]" : "text-[#166534]"}`}>
            {avisoOrden.tono === "pendiente" ? "① " : ""}{avisoOrden.titulo}
          </div>
          <div className={`text-xs mt-1 ${avisoOrden.tono === "pendiente" ? "text-[#1e3a8a]" : "text-[#166534]"}`}>{avisoOrden.detalle}</div>
          {avisoOrden.tono === "pendiente" && (
            <Link href="/radar-ia?tab=combustible" className="inline-block mt-2 px-4 py-2 rounded-lg text-sm font-bold text-white" style={{ background: "#1d4ed8" }}>
              Ir a Radar IA → Combustible
            </Link>
          )}
        </div>
      )}
      <CorreoFacturas onCodigo={setCodigoCorreo} />

      <div className="rounded-xl border bg-white p-4 flex flex-wrap items-center gap-4">
        <div className="text-sm text-gray-700 flex-1 min-w-[260px]">
          <b>La factura del correo es el respaldo oficial del Radar IA.</b> Cada 3 horas el ERP lee las facturas de los últimos {DIAS_REGISTRO_AUTOMATICO} días
          del correo conectado arriba (el XML de SUNAT; si no llega, el PDF del comprobante) y compara línea por línea con las cargas registradas.
          Las que faltan se registran solas —sin odómetro y con la fecha deducida, así que quedan en «Cargas por completar» hasta que alguien
          ponga el km del voucher y confirme la fecha—; las dudosas quedan aquí.
          {" "}<b>«📚 Leer el último año»</b> trae además las de los 12 meses anteriores: lo que falte de hace más de {DIAS_REGISTRO_AUTOMATICO} días
          no se registra solo — queda abajo, con cuántas cargas son y por cuánto, para que lo decidas tú.
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={sincronizar} disabled={!!cargando || registrando || sinCorreo}
            title={sinCorreo ? "Primero conecta el correo donde llegan las facturas (arriba)." : undefined}
            className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
            {cargando === "normal" ? "Sincronizando…" : "📧 Leer correo ahora"}
          </button>
          <button onClick={leerHistorial} disabled={!!cargando || registrando || sinCorreo}
            title={sinCorreo ? "Primero conecta el correo donde llegan las facturas (arriba)." : "Lee las facturas de los últimos 12 meses, por tandas."}
            className="px-4 py-2 rounded-lg text-sm font-bold border bg-white text-[#0b315f] disabled:opacity-60" style={{ borderColor: "#0b315f" }}>
            {cargando === "historial" ? "Leyendo el último año…" : "📚 Leer el último año"}
          </button>
          {resumen.errores > 0 && (
            <button onClick={reintentarErrores} disabled={!!cargando || registrando || sinCorreo}
              title="Vuelve a leer, uno por uno, los correos que quedaron en «Error». Los que sigan fallando dicen por qué en su fila."
              className="px-4 py-2 rounded-lg text-sm font-bold border bg-white text-red-700 border-red-300 disabled:opacity-60">
              {cargando === "reintento" ? "Reintentando…" : `🔁 Reintentar los ${resumen.errores} que fallaron`}
            </button>
          )}
        </div>
        {sinCorreo && <div className="basis-full text-xs text-amber-800">Primero conecta el correo donde llegan las facturas de Primax (bloque de arriba).</div>}
        {cargando === "historial" && <div className="basis-full text-xs text-gray-500">Puede tardar unos minutos: deja esta pestaña abierta. Si la cierras, lo ya leído queda guardado y se sigue con el mismo botón.</div>}
        {cruzando && <div className="basis-full text-xs text-gray-500">Cruzando las facturas pendientes con las cargas registradas…</div>}
        {sync && <div className="basis-full text-xs text-gray-600">{sync}</div>}
        <div className="basis-full flex flex-wrap gap-3 text-xs">
          <span style={{ color: ETIQUETA_LINEA.ya_registrada.color }}>✓ {resumen.ya} ya registradas</span>
          <span style={{ color: ETIQUETA_LINEA.registrar.color }}>＋ {resumen.reg} registradas por factura</span>
          <span style={{ color: ETIQUETA_LINEA.en_radar_pendiente.color }}>⏳ {resumen.radar} en revisión del Radar</span>
          <span style={{ color: ETIQUETA_LINEA.en_espera.color }}>… {resumen.esp} esperando al Radar</span>
          <span style={{ color: ETIQUETA_LINEA.revisar.color }}>⚠ {resumen.rev} para revisar</span>
          {resumen.hist > 0 && <span className="text-[#1d4ed8]">📚 {resumen.hist} del historial por decidir</span>}
          {!!porCompletar && <span className="text-amber-800 font-bold">✍ {porCompletar} carga(s) por completar (km y fecha)</span>}
        </div>
      </div>

      {/* Lo que la factura registró sin su voucher: el odómetro y la fecha del despacho los pone una
          persona (lib/combustible/completar-carga.ts). Es la otra mitad del respaldo. */}
      <CargasPorCompletar facturas={filas} pendRadar={pendRadar} onConteo={setPorCompletar} />

      {desf?.map((c) => {
        const d = c.decision;
        const r = c.por_mover;
        const aplica = d.dias > 0;
        return (
          <div key={c.cuenta_id} className="rounded-xl border bg-white p-4 space-y-2">
            <div className="text-sm text-gray-700">
              <b className={aplica ? "text-[#0b315f]" : "text-gray-600"}>📅 Fecha del despacho · {c.nombre}.</b> {d.detalle}
            </div>
            {/* Las de VARIAS cargas tienen su propia medición (y solo automática): el desfase que se fija
                a mano dice cuántos días, no que cada factura consolidada sea de un solo día. */}
            {d.consolidadas && (
              <div className={`text-sm ${d.consolidadas.fechar ? "text-[#0b315f]" : "text-gray-600"}`}>
                <b>Facturas de varias cargas.</b> {d.consolidadas.detalle}
              </div>
            )}
            {!!d.tardias && (
              <div className="text-xs text-gray-600">
                {d.tardias} factura(s) se generaron DESPUÉS de su fecha de emisión —el cierre de mes, que COESTI fecha el último día y emite
                el día 1—: no cuentan en la medición y su fecha no se corre.
              </div>
            )}
            <div className="text-xs text-gray-500">
              La factura no trae la fecha del despacho, solo la de emisión. Se corre la fecha que se dedujo de la emisión: la que trae la línea,
              o la que eliges al confirmar —que queda guardada—, no se toca. Se cambia en <b>⚙ Avisos</b> de la tarjeta «Saldo de combustible» →
              Facturas por correo.
            </div>
            {r.cargas > 0 && (
              <div className="rounded-lg border p-3 space-y-2" style={{ background: "#eff6ff", borderColor: "#93c5fd" }}>
                <div className="text-sm text-[#1e3a8a]">
                  <b>{r.cargas} carga(s) registradas desde la factura llevan la fecha de EMISIÓN</b> — del {F(r.desde)} al {F(r.hasta)}, por {S(r.total)}.
                  Con el desfase de {d.dias} día(s), el despacho fue {d.dias} día(s) antes.
                </div>
                {r.cruzan_mes > 0 && (
                  <div className="text-xs text-amber-800">⚠ {r.cruzan_mes} de ellas pasan al mes anterior: cambia el gasto de ese mes en Finanzas.</div>
                )}
                <details className="text-xs text-gray-700">
                  <summary className="cursor-pointer font-bold">Ver cuáles</summary>
                  <div className="mt-1 space-y-0.5">
                    {c.lista.map((x) => (
                      <div key={x.combustible_id} className="font-mono">
                        {x.placa ?? "—"} · {x.comprobante} · {F(x.desde)} → <b>{F(x.hacia)}</b> · {S(x.total)}{x.cruza_mes ? " · cambia de mes" : ""}
                      </div>
                    ))}
                    {r.cargas > c.lista.length && <div className="text-gray-500">… y {r.cargas - c.lista.length} más.</div>}
                  </div>
                </details>
                <button onClick={() => moverADespacho(c)} disabled={moviendo || !!cargando || registrando}
                  className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-60" style={{ background: "#1d4ed8" }}>
                  {moviendo ? "Moviendo…" : `Moverlas a la fecha del despacho`}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {msgDesf && <div className="text-xs text-gray-700 px-1">{msgDesf}</div>}

      {!!tipos?.length && (
        <div className="rounded-xl border p-4 space-y-2" style={{ background: "#fffbeb", borderColor: "#fcd34d" }}>
          <div className="text-sm text-amber-900">
            <b>{tipos.length} carga(s) registradas con otro combustible que el de su factura</b> — mismo despacho (placa, fecha,
            importe y cantidad), pero rotuladas con otro producto. Mientras sigan así cuentan en la serie equivocada (rendimiento,
            tanque y precio de referencia) y no aparecen al filtrar por su combustible. La factura es el documento legal del producto.
          </div>
          <div className="text-xs text-gray-700 space-y-0.5">
            {tipos.map((x) => (
              <div key={x.carga_id} className="font-mono">
                {x.placa ?? "—"} · {x.fecha} · carga #{x.carga_id} · {S(x.total)} · dice <b>{x.tipo_carga ? configCombustible(x.tipo_carga).label : "sin tipo"}</b> →
                factura {x.comprobante}: <b>{configCombustible(x.tipo_factura).label}</b>{x.producto ? ` («${x.producto}»)` : ""}
              </div>
            ))}
          </div>
          <button onClick={() => corregirTipos(tipos)} disabled={corrigiendo}
            className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-60" style={{ background: "#b45309" }}>
            {corrigiendo ? "Corrigiendo…" : `Corregir según la factura (${tipos.length})`}
          </button>
        </div>
      )}
      {msgTipos && <div className="text-xs text-gray-700 px-1">{msgTipos}</div>}

      {!!hist?.lineas && (
        <div className="rounded-xl border p-4 space-y-2" style={{ background: "#eff6ff", borderColor: "#93c5fd" }}>
          <div className="text-sm text-[#1e3a8a]">
            <b>📚 Del historial: {hist.lineas} carga(s) que no están en el ERP</b> — {hist.facturas} factura(s), del {F(hist.desde)} al {F(hist.hasta)}, por <b>{S(hist.total)}</b>.
          </div>
          <div className="text-xs text-gray-700">
            No se registraron solas porque son de hace más de {DIAS_REGISTRO_AUTOMATICO} días: son gastos de meses pasados. Si de verdad faltan
            (el Radar no las capturó), regístralas todas juntas. Si ese combustible ya lo anotaste por otro lado (un gasto, una caja chica),
            revísalas una por una abajo: cada línea del historial tiene su propio botón.
          </div>
          <button onClick={registrarHistorial} disabled={registrando || !!cargando}
            className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-60" style={{ background: "#1d4ed8" }}>
            {registrando ? "Registrando…" : `Registrar las ${hist.lineas} cargas del historial`}
          </button>
        </div>
      )}
      {msgHist && <div className="text-xs text-gray-700 px-1">{msgHist}</div>}

      {!!deuda?.docs.length && (
        <div className="rounded-xl border p-4 space-y-2" style={{ background: "#fffbeb", borderColor: "#fcd34d" }}>
          <div className="text-sm text-amber-900">
            <b>⚠ {deuda.docs.length} comprobante(s) de combustible figuran como deuda en Tesorería ({S(deuda.total)}) y no lo son.</b>{" "}
            Son de una cuenta prepago: se pagaron con el saldo depositado antes. Se crearon así antes de este arreglo; las facturas que se lean desde ahora nacen pagadas.
          </div>
          <details className="text-xs text-amber-900">
            <summary className="cursor-pointer font-bold">Ver cuáles</summary>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {deuda.docs.map((d) => <span key={d.id} className="font-mono">{d.serie}-{d.numero} · {F(d.fecha_emision)} · {S(d.total)}</span>)}
            </div>
          </details>
          <button onClick={marcarPagadas} disabled={marcando}
            className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-60" style={{ background: "#b45309" }}>
            {marcando ? "Marcando…" : "Marcarlos como pagados con el saldo prepago"}
          </button>
        </div>
      )}
      {msgDeuda && <div className="text-xs text-gray-700 px-1">{msgDeuda}</div>}

      {filas == null ? <div className="text-sm text-gray-400 p-4">Cargando…</div> :
       filas.length === 0 ? <div className="text-sm text-gray-500 p-6 text-center border rounded-xl bg-white">Todavía no hay facturas leídas. Conecta el correo arriba y pulsa «Leer correo ahora» (o «📚 Leer el último año»).</div> :
      <div className="rounded-xl border bg-white overflow-x-auto">
        {filas.length >= LIMITE && <div className="text-[11px] text-gray-500 px-3 pt-2">Se muestran las {LIMITE} más recientes.</div>}
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase text-gray-500">
            <tr><th className="p-2 text-left">Recibido</th><th className="p-2 text-left">Emisor</th><th className="p-2 text-left">Comprobante</th><th className="p-2 text-right">Total</th><th className="p-2 text-left">Fuente</th><th className="p-2 text-left">Estado</th><th></th></tr>
          </thead>
          <tbody>
            {filas.map((f) => {
              const [et, col] = ESTADO[f.estado] ?? [f.estado, "#6b7280"];
              const plan: PlanLinea[] = Array.isArray(f.conciliacion) ? f.conciliacion : [];
              const lineas: LineaFactura[] = Array.isArray(f.lineas) ? f.lineas : [];
              return (
                <React.Fragment key={f.id}>
                  <tr className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => setAbierta(abierta === f.id ? null : f.id)}>
                    <td className="p-2 whitespace-nowrap">
                      {/* Un correo que no se llegó a abrir no tiene fecha conocida: la de la fila es la del
                          INTENTO, y pintarla como «recibido» hace creer que fallaron las facturas de hoy. */}
                      {f.estado === "error" && !f.remitente_email
                        ? <span title="El correo no se pudo abrir, así que su fecha no se conoce: esta es la fecha del intento.">—<div className="text-[10px] text-gray-400">intento {f.recibido_en ? new Date(f.recibido_en).toLocaleDateString("es-PE") : ""}</div></span>
                        : f.recibido_en ? new Date(f.recibido_en).toLocaleDateString("es-PE") : "—"}
                    </td>
                    <td className="p-2">
                      {f.razon_social ?? f.remitente_email ?? (f.estado === "error" ? "Correo sin leer" : "—")}
                      <div className="text-[11px] text-gray-400">{f.asunto}</div>
                      {/* El motivo a la vista: «Error» a secas obliga a abrir fila por fila para saber qué pasó. */}
                      {f.estado === "error" && f.error && <div className="text-[11px] text-red-700 line-clamp-2" title={f.error}>{f.error}</div>}
                    </td>
                    <td className="p-2 font-mono text-xs">{f.serie && f.numero ? `${f.serie}-${f.numero}` : "—"}</td>
                    <td className="p-2 text-right font-bold">{S(f.total)}</td>
                    <td className="p-2 text-xs">{f.fuente_extraccion === "xml_ubl" ? "XML SUNAT" : f.fuente_extraccion === "vision_pdf" ? "PDF (IA)" : "—"}</td>
                    <td className="p-2"><span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: col + "1a", color: col }}>{et}</span></td>
                    <td className="p-2 text-xs text-gray-400">{abierta === f.id ? "▲" : "▼"}</td>
                  </tr>
                  {abierta === f.id && (
                    <tr className="bg-gray-50"><td colSpan={7} className="p-3 space-y-2">
                      {f.error && <div className="text-xs text-red-700">{f.error}</div>}
                      {f.diferencia_detalle && <div className="text-xs text-amber-800">{f.diferencia_detalle}</div>}
                      {/* El documento, bajado del correo por el ERP, y el correo en la cuenta del buzón (antes
                          `u/0`: con dos cuentas abiertas Gmail lo buscaba en la equivocada). Un correo que no
                          trae la factura no ofrece «Ver la factura»: ya se sabe que no hay qué ver. */}
                      {f.gmail_message_id && <BotonesFactura factura={f} conDocumento={f.estado !== "sin_adjunto"} />}
                      {lineas.map((l) => {
                        const p = plan.find((x) => x.n === l.n);
                        // Lo del historial no es un problema de la línea: es una decisión pendiente.
                        const et2 = !p ? null : p.motivo === "historico" ? { texto: "Del historial", color: "#1d4ed8" } : ETIQUETA_LINEA[p.codigo];
                        const k = `${f.id}:${l.n}`;
                        // La fecha con que se juzgó la línea: la del despacho si se dedujo de la emisión (o, en una
                        // factura de varias cargas, la de emisión cuando su medición dice «el mismo día»).
                        const despacho = p?.desfase ? sumarDias(p.desfase.emision, -p.desfase.dias)
                          : p?.fecha_origen === "consolidada" && f.fecha_emision ? String(f.fecha_emision).slice(0, 10) : l.fecha;
                        const e = elec[k] ?? { placa: l.placa ?? "", fecha: despacho ?? "" };
                        const confirmable = p && (p.codigo === "revisar" || p.codigo === "en_espera") && p.motivo !== "no_cuadra" && p.motivo !== "ambigua" && p.motivo !== "nota_credito";
                        return (
                          <div key={l.n} className="rounded-lg border bg-white p-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-bold">#{l.n}</span>
                            <span className="min-w-[160px]">{l.descripcion || "—"}</span>
                            <span>{l.cantidad ?? "—"} {l.unidad_codigo ?? ""} × {l.precio_unitario ?? "—"} = <b>{S(l.total)}</b></span>
                            <span>🚌 {l.placa ?? "sin placa"}</span>
                            {p?.desfase
                              ? <span title={`La factura no trae la fecha del despacho: se emitió el ${F(p.desfase.emision)} y el despacho se toma ${p.desfase.dias} día(s) antes.`}>
                                  📅 {F(despacho)} <span className="text-gray-400">(emitida {F(p.desfase.emision)})</span>
                                </span>
                              : <span>📅 {despacho ? F(despacho) : "sin fecha"}</span>}
                            {l.nota_despacho && <span className="font-mono">{l.nota_despacho}</span>}
                            {et2 && <span className="font-bold px-2 py-0.5 rounded-full" style={{ background: et2.color + "1a", color: et2.color }}>{et2.texto}</span>}
                            {p && <div className="basis-full text-gray-600">{p.detalle}{p.codigo === "en_radar_pendiente" && <> <Link href="/radar-ia?tab=combustible" className="text-[#1d4ed8] font-bold hover:underline">Ir a Radar IA →</Link></>}</div>}
                            {/* Una factura de VARIAS líneas no trae fecha para ninguna: el desfase medido sugiere el
                                día más probable, como TEXTO. No se precarga: una factura que junta despachos
                                puede traer días distintos, y esa la decide quien la confirma. */}
                            {/* Un cierre de mes (generada después de su fecha) no sigue el lote nocturno: ahí la pista
                                se calla, porque «emisión − 1» sería justamente la fecha equivocada. */}
                            {p?.motivo === "sin_fecha" && f.fecha_emision && !generadaDespues(f.fecha_emision, f.recibido_en) && (() => {
                              const dec = desf?.find((c) => c.cuenta_id === Number(f.cuenta_id))?.decision;
                              return dec && dec.dias > 0
                                ? <div className="basis-full text-[#1d4ed8]">Lo más probable: el {F(sumarDias(String(f.fecha_emision).slice(0, 10), -dec.dias))} — la factura se emitió el {F(f.fecha_emision)} y en esta cuenta sale {dec.dias} día(s) después del despacho. Si junta despachos de días distintos, mira cada voucher.</div>
                                : null;
                            })()}
                            {p?.motivo === "sin_fecha" && f.fecha_emision && generadaDespues(f.fecha_emision, f.recibido_en) && (
                              <div className="basis-full text-[#1d4ed8]">Cierre de mes: dice {F(f.fecha_emision)} y se generó el {F(diaLima(f.recibido_en))}. Puede juntar despachos de varios días: mira cada voucher.</div>
                            )}
                            {/* Antes de registrar desde la factura: ¿el voucher de esta carga sigue por revisar en
                                el Radar? Si es así, lo que corresponde es registrarlo allá (trae el odómetro y la
                                fecha del despacho) y dejar que esta línea se cruce sola. Se dice; no se bloquea. */}
                            {/* Y si la factura YA la registró sola: su voucher, si sigue por revisar en el Radar, se
                                FUSIONA allá con esta carga (±1 día: la ventana con que el Radar la reconoce). */}
                            {p?.codigo === "registrar" && pendRadar && (() => {
                              const cerca = pendientesCerca({ placa: l.placa, fecha: despacho }, pendRadar, 1);
                              return cerca.length > 0 ? (
                                <div className="basis-full text-[#1d4ed8]">
                                  🔗 En el Radar hay {cerca.length} recarga(s) de {l.placa} por revisar del {cerca.slice(0, 3).map((r) => F(r.fecha)).join(", ")}:
                                  si una es esta carga, allá aparece para <b>fusionarla</b> con esta (toma la fecha del despacho y el odómetro). No la registres aparte.{" "}
                                  <Link href="/radar-ia?tab=combustible" className="font-bold hover:underline">Ir a Radar IA →</Link>
                                </div>
                              ) : null;
                            })()}
                            {confirmable && pendRadar && (() => {
                              const placa = e.placa || l.placa;
                              const cerca = pendientesCerca({ placa, fecha: e.fecha || despacho }, pendRadar);
                              return cerca.length > 0 ? (
                                <div className="basis-full text-amber-800">
                                  ⚠ En el Radar hay {cerca.length} recarga(s) de {placa} por revisar cerca de esta fecha
                                  ({cerca.slice(0, 4).map((r) => `${F(r.fecha)}${r.monto != null ? ` · ${S(r.monto)}` : ""}`).join("; ")}{cerca.length > 4 ? "; …" : ""}).
                                  Si una es esta carga, regístrala allá —trae el odómetro y la fecha del despacho— y esta línea se cruzará sola.{" "}
                                  <Link href="/radar-ia?tab=combustible" className="text-[#1d4ed8] font-bold hover:underline">Ir a Radar IA →</Link>
                                </div>
                              ) : null;
                            })()}
                            {confirmable && (
                              <div className="basis-full flex flex-wrap items-center gap-2 pt-1">
                                <select value={e.placa} onChange={(ev) => setElec({ ...elec, [k]: { ...e, placa: ev.target.value } })} className="border rounded px-2 py-1">
                                  <option value="">— placa —</option>
                                  {placas.map((pl) => <option key={pl} value={pl}>{pl}</option>)}
                                </select>
                                <input type="date" value={e.fecha} onChange={(ev) => setElec({ ...elec, [k]: { ...e, fecha: ev.target.value } })} className="border rounded px-2 py-1" />
                                <button disabled={!e.placa || !e.fecha || !!enCurso[`${f.id}-${l.n}`]} onClick={() => confirmar(f, l.n, e)}
                                  className="px-3 py-1 rounded font-bold text-white disabled:opacity-50" style={{ background: "#1d4ed8" }}>
                                  {enCurso[`${f.id}-${l.n}`] === "registrando" ? "Registrando…" : enCurso[`${f.id}-${l.n}`] === "espera" ? "En cola…" : "Registrar esta carga"}
                                </button>
                                <span className="text-gray-500">Se registra sin odómetro, enlazada a esta factura.</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {f.estado !== "descartada" && <button onClick={() => descartar(f)} className="text-xs text-gray-500 hover:underline">Descartar: no es una factura de combustible</button>}
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>}
    </section>
  );
}
