"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /liquidaciones — Cierre de periodo entre Operaciones y Finanzas.
//
//   Pestaña CLIENTE:   servicios finalizados "por liquidar" → valorización por
//                      cliente + sede → PDF AFA-FL-07 → conformidad → factura.
//   Pestaña PROVEEDOR: servicios tercerizados "por conciliar" → AFA-FL-08 →
//                      cuenta por pagar.
//
// La idea central: no se liquida servicio por servicio, se CIERRA UN PERIODO. Se
// eligen los grupos y un botón genera todas las liquidaciones del mes de una pasada.
// Antes de dejar liquidar, la pantalla muestra en rojo lo que está mal (sin precio,
// sin unidad, no finalizado): una valorización mal armada se descubre cuando el
// cliente la rechaza, semanas después.
//
// Requiere haber corrido supabase/liquidaciones-v2.sql.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import {
  agruparServicios, analizarServicios,
  type ReservaLiq, type CatalogoLiq, type LineaAgrupada, type LadoLiquidacion, type ParServicio,
} from "@/lib/liquidacion-agrupacion";
import {
  crearLiquidaciones, igvVigente, aprobarLiquidacionCliente, aprobarLiquidacionProveedor,
  anularLiquidacion, volverABorrador, hoyLima,
} from "@/lib/liquidaciones";
import { cargarDocumentoLiquidacion } from "@/lib/liquidacion-datos";
import { buildLiquidacionHtml } from "@/lib/liquidacion-doc";
import ModalEditor from "./ModalEditor";
import ModalSede, { SEDE_VACIA, type Sede } from "./ModalSede";
import ModalEnviar from "./ModalEnviar";

const COLS_RESERVA =
  "id,codigo,fecha_servicio,hora_servicio,estado,estado_admin,estado_proveedor,cliente_id,cliente_sede_id," +
  "ruta_nombre,direccion_servicio,origen,destino,precio_cliente,costo_proveedor,tipo_asignacion," +
  "vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,empresa_tercerizada_id," +
  "pasajeros_abordados,hora_real_inicio,hora_real_fin,tipo_servicio_detalle," +
  "reserva_vinculada_id,liquidacion_cliente_id,liquidacion_proveedor_id";

/** Paginación defensiva: PostgREST corta en 1000 filas y un mes de operación pasa de eso. */
async function traerTodo(query: () => any): Promise<any[]> {
  const paso = 1000; let desde = 0; const acc: any[] = [];
  for (;;) {
    const { data, error } = await query().range(desde, desde + paso - 1);
    if (error) throw new Error(error.message);
    const filas = (data as any[]) ?? [];
    acc.push(...filas);
    if (filas.length < paso) break;
    desde += paso;
  }
  return acc;
}

// ── Periodo ─────────────────────────────────────────────────────────────────

function mesAnterior(): { desde: string; hasta: string } {
  const hoy = new Date(hoyLima() + "T12:00:00");
  const primero = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const ultimo = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { desde: f(primero), hasta: f(ultimo) };
}

/** Quincena "del 15 al 14", que es como cierran varios clientes corporativos de AFA. */
function quincena15(): { desde: string; hasta: string } {
  const hoy = new Date(hoyLima() + "T12:00:00");
  const finMes = hoy.getDate() > 14 ? hoy.getMonth() : hoy.getMonth() - 1;
  const desde = new Date(hoy.getFullYear(), finMes - 1, 15);
  const hasta = new Date(hoy.getFullYear(), finMes, 14);
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { desde: f(desde), hasta: f(hasta) };
}

const fCorta = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

// ── Grupos que se muestran en el árbol ──────────────────────────────────────

type Grupo = {
  clave: string;
  contraparteId: number | null;
  contraparteNombre: string;
  sedeId: number | null;
  sedeNombre: string;
  sede: Sede | null;
  lineas: LineaAgrupada[];
  /** Todas las reservas del grupo en el periodo, antes de emparejar ida+retorno. */
  reservas: ReservaLiq[];
  /** Servicios facturables (el par ida+retorno cuenta como uno). */
  pares: ParServicio[];
  bloqueadas: { r: ReservaLiq; motivos: string[] }[];
  avisos: { r: ReservaLiq; mensaje: string }[];
  total: number;
};

export default function LiquidacionesPage() {
  const [lado, setLado] = useState<LadoLiquidacion>("cliente");
  const [vista, setVista] = useState<"cierre" | "documentos">("cierre");
  const [periodo, setPeriodo] = useState(mesAnterior());
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState("");
  const [errorSql, setErrorSql] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  const [reservas, setReservas] = useState<ReservaLiq[]>([]);
  const [clientes, setClientes] = useState<Record<number, any>>({});
  const [terceros, setTerceros] = useState<Record<number, any>>({});
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [vehiculos, setVehiculos] = useState<Record<string, { placa: string; cap: number | null }>>({});
  const [conductores, setConductores] = useState<Record<string, string>>({});
  const [liquidaciones, setLiquidaciones] = useState<any[]>([]);
  const [igvPct, setIgvPct] = useState(18);
  const [usuario, setUsuario] = useState("");

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [abierto, setAbierto] = useState<Set<string>>(new Set());
  const [preciosConIgv, setPreciosConIgv] = useState(false);

  const [editor, setEditor] = useState<number | null>(null);
  const [modalSede, setModalSede] = useState<{ sede: Sede; cliente: string } | null>(null);
  const [enviar, setEnviar] = useState<any | null>(null);

  // ── Carga ────────────────────────────────────────────────────────────────
  async function cargar() {
    setCargando(true); setErrorSql("");
    try {
      const { data: sesion } = await supabase.auth.getSession();
      const correo = sesion?.session?.user?.email ?? "";
      setUsuario(correo);

      const rs = await traerTodo(() =>
        supabase.from("reservas").select(COLS_RESERVA)
          .gte("fecha_servicio", periodo.desde).lte("fecha_servicio", periodo.hasta)
          .order("fecha_servicio", { ascending: true })
      );
      setReservas(rs as ReservaLiq[]);

      const [cl, te, ve, vt, co, ct, cfg] = await Promise.all([
        supabase.from("clientes").select("id,nombre,empresa,ruc,email,telefono,administrativo_nombre,administrativo_email,administrativo_celular"),
        supabase.from("empresas_tercerizadas").select("id,razon_social,ruc,email,telefono,contacto_nombre,contacto_telefono"),
        supabase.from("vehiculos").select("id,placa,capacidad_pasajeros"),
        supabase.from("vehiculos_tercero").select("id,placa,capacidad"),
        supabase.from("conductores").select("id,nombre"),
        supabase.from("conductores_tercero").select("id,nombre"),
        igvVigente(supabase),
      ]);
      const cmap: Record<number, any> = {}; for (const c of ((cl.data as any[]) ?? [])) cmap[c.id] = c;
      const tmap: Record<number, any> = {}; for (const t of ((te.data as any[]) ?? [])) tmap[t.id] = t;
      const vmap: Record<string, any> = {};
      for (const v of ((ve.data as any[]) ?? [])) vmap["p" + v.id] = { placa: v.placa, cap: v.capacidad_pasajeros };
      for (const v of ((vt.data as any[]) ?? [])) vmap["t" + v.id] = { placa: v.placa, cap: v.capacidad };
      const comap: Record<string, string> = {};
      for (const c of ((co.data as any[]) ?? [])) comap["p" + c.id] = c.nombre;
      for (const c of ((ct.data as any[]) ?? [])) comap["t" + c.id] = c.nombre;
      setClientes(cmap); setTerceros(tmap); setVehiculos(vmap); setConductores(comap); setIgvPct(cfg);

      // Las tablas nuevas pueden no existir todavía: se avisa y la pantalla sigue viva.
      const sd = await supabase.from("cliente_sedes").select("*").eq("activo", true).order("nombre");
      if (sd.error) setErrorSql("Falta correr supabase/liquidaciones-v2.sql en Supabase: sin eso no se puede liquidar ni emitir el formato.");
      setSedes(((sd.data as any[]) ?? []) as Sede[]);

      await cargarLiquidaciones();
    } catch (e: any) {
      setErrorSql(String(e?.message ?? e));
    } finally {
      setCargando(false);
    }
  }

  async function cargarLiquidaciones() {
    const tabla = lado === "cliente" ? "liquidacion_cliente" : "liquidacion_proveedor";
    const { data, error } = await supabase.from(tabla).select("*").order("id", { ascending: false }).limit(200);
    if (!error) setLiquidaciones((data as any[]) ?? []);
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [periodo.desde, periodo.hasta]);
  useEffect(() => { cargarLiquidaciones(); setSel(new Set()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lado]);

  // ── Catálogo para la agrupación ──────────────────────────────────────────
  const catalogo: CatalogoLiq = useMemo(() => ({
    placaDe: (r) => vehiculos[(r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id)]?.placa ?? "",
    capacidadDe: (r) => vehiculos[(r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id)]?.cap ?? null,
    conductorDe: (r) => conductores[(r.conductor_tercero_id ? "t" : "p") + (r.conductor_tercero_id ?? r.conductor_id)] ?? "",
  }), [vehiculos, conductores]);

  /**
   * Sede a la que pertenece un servicio. Prioriza lo escrito en la reserva; si no,
   * usa los patrones de la sede (nombre de ruta, origen, destino); si el cliente
   * tiene una sola sede, esa. Nunca inventa: si no hay match, cae en "sin sede" y
   * el grupo igual se puede liquidar.
   */
  function sedeDe(r: ReservaLiq): Sede | null {
    if (r.cliente_sede_id) return sedes.find((s) => s.id === r.cliente_sede_id) ?? null;
    const delCliente = sedes.filter((s) => s.cliente_id === r.cliente_id);
    if (!delCliente.length) return null;
    if (delCliente.length === 1) return delCliente[0];
    const texto = `${r.ruta_nombre ?? ""} ${r.origen ?? ""} ${r.destino ?? ""}`.toUpperCase();
    return delCliente.find((s) => (s.patrones ?? []).some((p) => p && texto.includes(p))) ?? null;
  }

  // ── Árbol de grupos ──────────────────────────────────────────────────────
  const grupos: Grupo[] = useMemo(() => {
    const candidatas = reservas.filter((r) => {
      if (lado === "cliente") return !r.liquidacion_cliente_id && (r.estado_admin === "por_liquidar" || !r.estado_admin);
      return !r.liquidacion_proveedor_id && (r.tipo_asignacion === "tercerizado" || !!r.empresa_tercerizada_id);
    });

    const mapa = new Map<string, Grupo>();
    for (const r of candidatas) {
      const contraparteId = lado === "cliente" ? r.cliente_id : (r.empresa_tercerizada_id ?? null);
      const sede = lado === "cliente" ? sedeDe(r) : null;
      const clave = `${contraparteId ?? "x"}|${sede?.id ?? "0"}`;
      const nombre = lado === "cliente"
        ? (contraparteId != null ? (clientes[contraparteId]?.empresa || clientes[contraparteId]?.nombre || `Cliente ${contraparteId}`) : "Sin cliente")
        : (contraparteId != null ? (terceros[contraparteId]?.razon_social || `Empresa ${contraparteId}`) : "Sin empresa");
      const g: Grupo = mapa.get(clave) ?? {
        clave, contraparteId, contraparteNombre: nombre,
        sedeId: sede?.id ?? null, sedeNombre: sede?.nombre ?? (lado === "cliente" ? "Sin sede asignada" : "Servicios tercerizados"),
        sede, lineas: [] as LineaAgrupada[], reservas: [] as ReservaLiq[],
        pares: [] as ParServicio[],
        bloqueadas: [] as { r: ReservaLiq; motivos: string[] }[],
        avisos: [] as { r: ReservaLiq; mensaje: string }[], total: 0,
      };
      g.reservas.push(r);
      mapa.set(clave, g);
    }

    for (const g of mapa.values()) {
      // Emparejar ida+retorno ANTES de agrupar: AFA cobra una tarifa por los dos
      // tramos del día, así que la unidad facturable es el par, no la reserva.
      const analisis = analizarServicios(g.reservas, lado);
      g.pares = analisis.pares;
      g.bloqueadas = analisis.bloqueadas;
      g.avisos = analisis.avisos;

      g.lineas = agruparServicios(g.pares, {
        lado, catalogo, preciosIncluyenIgv: preciosConIgv, igvPct,
        sede: g.sede?.nombre ?? null, desde: periodo.desde, hasta: periodo.hasta,
        concepto: g.sede?.servicio_contratado?.replace(/^SERVICIO DE /i, "") || "TRANSPORTE DE PERSONAL",
      })
        // Una línea sin servicios ejecutados no va al documento: solo aportaría un
        // renglón de 0 × S/ 0.00. Lo programado y no prestado se sigue viendo en la
        // columna PROG./EJEC. de las demás líneas y en los avisos del grupo.
        .filter((l) => l.cantidad > 0);
      g.total = g.lineas.reduce((a, l) => a + l.total_linea, 0);
    }

    return [...mapa.values()].sort((a, b) => b.total - a.total || a.contraparteNombre.localeCompare(b.contraparteNombre));
  }, [reservas, lado, clientes, terceros, sedes, catalogo, igvPct, preciosConIgv, periodo.desde, periodo.hasta]);

  const seleccionados = grupos.filter((g) => sel.has(g.clave) && g.lineas.length);
  const totalSeleccionado = seleccionados.reduce((a, g) => a + g.total, 0);

  function toggle(clave: string) {
    setSel((s) => { const n = new Set(s); n.has(clave) ? n.delete(clave) : n.add(clave); return n; });
  }
  function toggleAbierto(clave: string) {
    setAbierto((s) => { const n = new Set(s); n.has(clave) ? n.delete(clave) : n.add(clave); return n; });
  }

  // ── Acciones ─────────────────────────────────────────────────────────────

  async function liquidarSeleccion() {
    if (!seleccionados.length) { setMsg("⚠️ Marca al menos un grupo."); return; }
    setTrabajando(true); setMsg("");
    try {
      const res = await crearLiquidaciones(supabase,
        seleccionados.map((g) => ({
          contraparteId: g.contraparteId,
          sedeId: g.sedeId,
          lineas: g.lineas,
          cabecera: {
            area_solicitante: g.sede?.area_solicitante ?? g.sede?.nombre ?? null,
            usuario_solicita: g.sede?.usuario_solicita ?? null,
            cargo_solicita: g.sede?.cargo_solicita ?? null,
            servicio_contratado: g.sede?.servicio_contratado ?? null,
            ubicacion_servicio: g.sede?.ubicacion_servicio ?? g.sede?.nombre ?? null,
            orden_compra: g.sede?.orden_compra ?? null,
            moneda: g.sede?.moneda ?? "PEN",
            responsable_afa: lado === "proveedor" ? usuario : null,
          },
        })),
        {
          lado, periodoDesde: periodo.desde, periodoHasta: periodo.hasta,
          periodoLabel: `${fCorta(periodo.desde)} AL ${fCorta(periodo.hasta)}`,
          igvPct, preciosIncluyenIgv: preciosConIgv, usuario,
        });

      const ok = res.creadas.length;
      setMsg(
        `${ok ? "✅" : "⚠️"} ${ok} liquidación(es) creada(s) en borrador${res.errores.length ? ` · ${res.errores.length} con problemas: ${res.errores[0]}` : ""}.`
      );
      setSel(new Set());
      setVista("documentos");
      await cargar();
    } finally { setTrabajando(false); }
  }

  /** Abre el documento en una ventana nueva, listo para imprimir o guardar como PDF. */
  async function verPdf(id: number) {
    setTrabajando(true);
    try {
      const fila = liquidaciones.find((l) => l.id === id);
      const url = fila?.token ? `${location.origin}/conformidad/${fila.token}` : null;
      const doc = await cargarDocumentoLiquidacion(supabase, lado, { id }, { urlPublica: url });
      if (!doc) { setMsg("⚠️ No se pudo armar el documento."); return; }
      const win = window.open("", "_blank");
      if (!win) { setMsg("⚠️ El navegador bloqueó la ventana emergente."); return; }
      win.document.write(
        buildLiquidacionHtml(doc).replace("</body>", "<script>window.onload=()=>setTimeout(()=>window.print(),350);<\/script></body>")
      );
      win.document.close();
    } finally { setTrabajando(false); }
  }

  async function aprobar(l: any) {
    const texto = lado === "cliente"
      ? `¿Aprobar ${l.codigo} y emitir la factura por ${fmtMoneda(Number(l.total ?? 0), l.moneda)}?`
      : `¿Aprobar ${l.codigo} y generar la cuenta por pagar por ${fmtMoneda(Number(l.total ?? 0), l.moneda)}?`;
    if (!confirm(texto)) return;
    setTrabajando(true);
    const r = lado === "cliente"
      ? await aprobarLiquidacionCliente(supabase, l.id, usuario)
      : await aprobarLiquidacionProveedor(supabase, l.id, usuario);
    setMsg(r.ok
      ? (lado === "cliente" ? `✅ Facturada (factura #${(r as any).factura_id}).` : `✅ Aprobada.${(r as any).aviso ? " " + (r as any).aviso : ` Cuenta por pagar #${(r as any).documento_compra_id}.`}`)
      : `⚠️ ${r.error}`);
    await cargar(); setTrabajando(false);
  }

  async function anular(l: any) {
    const motivo = prompt(`Motivo de la anulación de ${l.codigo}:`);
    if (!motivo) return;
    setTrabajando(true);
    const r = await anularLiquidacion(supabase, lado, l.id, motivo, usuario);
    setMsg(r.ok ? "✅ Anulada. Sus servicios volvieron a estar por liquidar." : `⚠️ ${r.error}`);
    await cargar(); setTrabajando(false);
  }

  async function reabrir(l: any) {
    setTrabajando(true);
    const r = await volverABorrador(supabase, lado, l.id, usuario);
    setMsg(r.ok ? "✅ Reabierta como borrador." : `⚠️ ${r.error}`);
    await cargar(); setTrabajando(false);
  }

  const cp = lado === "cliente" ? "#0b315f" : "#6d28d9";

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto pb-16">
      <div className="mb-4">
        <h1 className="text-2xl font-black" style={{ color: cp }}>Liquidaciones</h1>
        <p className="text-sm text-gray-500">
          Cierre del periodo: valoriza los servicios ejecutados, emite el Formato de Liquidación y Conformidad, y recién ahí factura o paga.
        </p>
      </div>

      {/* Pestañas */}
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        {(["cliente", "proveedor"] as const).map((t) => (
          <button key={t} onClick={() => setLado(t)}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition ${lado === t ? "text-white shadow" : "bg-white text-gray-600 hover:bg-gray-50 border"}`}
            style={lado === t ? { background: t === "cliente" ? "#0b315f" : "#6d28d9" } : {}}>
            {t === "cliente" ? "Al Cliente (facturar)" : "Al Proveedor (pagar)"}
          </button>
        ))}
        <div className="w-px h-7 bg-gray-200 mx-1" />
        {(["cierre", "documentos"] as const).map((v) => (
          <button key={v} onClick={() => setVista(v)}
            className={`px-3 py-2 rounded-xl text-sm font-bold ${vista === v ? "bg-gray-900 text-white" : "bg-white text-gray-600 border hover:bg-gray-50"}`}>
            {v === "cierre" ? "Cerrar periodo" : `Documentos (${liquidaciones.length})`}
          </button>
        ))}
        <button onClick={cargar} className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold bg-white border hover:bg-gray-50">↻ Recargar</button>
      </div>

      {errorSql && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
          <b>Falta un paso en la base de datos.</b> {errorSql}
        </div>
      )}
      {msg && <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

      {/* Filtros de periodo */}
      <div className="bg-gray-50 border rounded-2xl p-3 mb-4 flex flex-wrap gap-2 items-center">
        <span className="text-xs font-black text-gray-500 uppercase tracking-wide">Periodo</span>
        <input type="date" value={periodo.desde} onChange={(e) => setPeriodo({ ...periodo, desde: e.target.value })}
          className="px-3 py-1.5 rounded-xl border text-sm" />
        <span className="text-gray-400 text-sm">al</span>
        <input type="date" value={periodo.hasta} onChange={(e) => setPeriodo({ ...periodo, hasta: e.target.value })}
          className="px-3 py-1.5 rounded-xl border text-sm" />
        <button onClick={() => setPeriodo(mesAnterior())} className="px-3 py-1.5 rounded-xl border bg-white text-xs font-bold hover:bg-gray-50">Mes pasado</button>
        <button onClick={() => setPeriodo(quincena15())} className="px-3 py-1.5 rounded-xl border bg-white text-xs font-bold hover:bg-gray-50">Del 15 al 14</button>
        <label className="ml-auto flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={preciosConIgv} onChange={(e) => setPreciosConIgv(e.target.checked)} />
          Los precios del ERP ya incluyen IGV
        </label>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-gray-400">Cargando el periodo…</div>
      ) : vista === "cierre" ? (
        <>
          {/* Barra de acción masiva */}
          <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border rounded-2xl p-3 mb-3 flex flex-wrap items-center gap-3 shadow-sm">
            <span className="text-sm text-gray-600">
              <b>{grupos.length}</b> grupo(s) en el periodo · <b>{seleccionados.length}</b> seleccionado(s)
            </span>
            <span className="font-black" style={{ color: cp }}>{fmtMoneda(totalSeleccionado)}</span>
            <button disabled={trabajando || !seleccionados.length} onClick={liquidarSeleccion}
              className="ml-auto px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
              {trabajando ? "Generando…" : `Liquidar ${seleccionados.length || ""} grupo(s) → ${seleccionados.length || 0} documento(s)`}
            </button>
          </div>

          {grupos.length === 0 ? (
            <div className="bg-white rounded-2xl border p-10 text-center text-gray-400">
              No hay servicios {lado === "cliente" ? "por liquidar" : "tercerizados por conciliar"} en este periodo. 🎉
            </div>
          ) : grupos.map((g) => {
            const abiertoG = abierto.has(g.clave);
            const listo = g.lineas.length > 0;
            return (
              <div key={g.clave} className={`bg-white rounded-2xl border shadow-sm mb-3 overflow-hidden ${!listo ? "border-red-200" : ""}`}>
                <div className={`flex items-center gap-3 px-4 py-3 border-b ${listo ? "bg-gray-50" : "bg-red-50"}`}>
                  <input type="checkbox" disabled={!listo} checked={sel.has(g.clave)} onChange={() => toggle(g.clave)} />
                  <button onClick={() => toggleAbierto(g.clave)} className="text-left flex-1">
                    <span className="font-bold" style={{ color: listo ? cp : "#991b1b" }}>{g.contraparteNombre}</span>
                    <span className="text-xs text-gray-500 ml-2">{g.sedeNombre}</span>
                    <span className="text-xs text-gray-400 ml-2">
                      {g.pares.filter((p) => p.ejecutado).length} servicio(s)
                      {g.pares.some((p) => p.adjuntas.length) ? " (ida y retorno)" : ""}
                      {g.bloqueadas.length ? ` · ${g.bloqueadas.length} con problema` : ""}
                    </span>
                  </button>
                  {lado === "cliente" && (
                    <button
                      onClick={() => setModalSede({
                        sede: g.sede ?? SEDE_VACIA(g.contraparteId),
                        cliente: g.contraparteNombre,
                      })}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold border hover:bg-white">
                      {g.sede ? "✎ Sede" : "+ Crear sede"}
                    </button>
                  )}
                  <span className="font-black text-gray-700">{fmtMoneda(g.total)}</span>
                  <span className="text-gray-400 text-xs">{abiertoG ? "▲" : "▼"}</span>
                </div>

                {!g.sede && lado === "cliente" && (
                  <div className="px-4 py-2 bg-amber-50 border-b text-[11px] text-amber-800">
                    Este grupo no tiene sede: el formato saldrá sin área solicitante ni usuario que aprueba, y no habrá a quién enviarle la conformidad.
                  </div>
                )}

                {abiertoG && (
                  <div className="divide-y">
                    {g.lineas.map((l) => (
                      <div key={l.clave} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <span className="flex-1 text-gray-700">
                          {l.ruta} · Turno {l.turno}{l.movil ? ` · Móvil ${l.movil}` : ""}
                          <span className="text-gray-400 ml-2">{l.placas.join(", ")}</span>
                        </span>
                        <span className="text-xs text-gray-500">
                          {l.cantidad_ejecutada}/{l.cantidad_programada} serv. × {fmtMoneda(l.precio_unitario)}
                        </span>
                        <span className="w-28 text-right font-bold text-gray-700">{fmtMoneda(l.total_linea)}</span>
                      </div>
                    ))}
                    {g.avisos.length > 0 && (
                      <div className="px-4 py-3 bg-amber-50/60">
                        <p className="text-[11px] font-black text-amber-700 uppercase tracking-wide mb-1">Revisa antes de emitir</p>
                        {g.avisos.slice(0, 6).map(({ r, mensaje }) => (
                          <div key={r.id} className="text-[11px] text-amber-800 flex gap-2">
                            <span className="font-mono">{r.codigo ?? "#" + r.id}</span>
                            <span>{mensaje}</span>
                          </div>
                        ))}
                        {g.avisos.length > 6 && <p className="text-[11px] text-amber-600 mt-1">y {g.avisos.length - 6} más…</p>}
                      </div>
                    )}
                    {g.bloqueadas.length > 0 && (
                      <div className="px-4 py-3 bg-red-50/60">
                        <p className="text-[11px] font-black text-red-700 uppercase tracking-wide mb-1">No se pueden liquidar todavía</p>
                        {g.bloqueadas.slice(0, 8).map(({ r, motivos }) => (
                          <div key={r.id} className="text-[11px] text-red-700 flex gap-2">
                            <span className="font-mono">{r.codigo ?? "#" + r.id}</span>
                            <span className="text-red-400">{r.fecha_servicio}</span>
                            <span className="text-red-400">{r.direccion_servicio === "retorno" ? "retorno" : "ida"}</span>
                            <span>{motivos.join(" · ")}</span>
                          </div>
                        ))}
                        {g.bloqueadas.length > 8 && <p className="text-[11px] text-red-500 mt-1">y {g.bloqueadas.length - 8} más…</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      ) : (
        /* ── Documentos emitidos ─────────────────────────────────────────── */
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {liquidaciones.length === 0 ? (
            <div className="p-10 text-center text-gray-400 text-sm">Todavía no hay liquidaciones.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-400 text-[11px] uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Código</th>
                  <th className="text-left px-4 py-2">{lado === "cliente" ? "Cliente / sede" : "Empresa"}</th>
                  <th className="text-left px-4 py-2">Periodo</th>
                  <th className="text-right px-4 py-2">Total</th>
                  <th className="text-left px-4 py-2">Estado</th>
                  <th className="text-left px-4 py-2">Conformidad</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {liquidaciones.map((l) => {
                  const nombre = lado === "cliente"
                    ? (clientes[l.cliente_id]?.empresa || clientes[l.cliente_id]?.nombre || "—")
                    : (terceros[l.empresa_tercerizada_id]?.razon_social || "—");
                  const sede = sedes.find((s) => s.id === l.cliente_sede_id);
                  const conf = l.conformidad_estado ?? "pendiente";
                  const colorConf = conf === "conforme" ? "bg-emerald-100 text-emerald-700"
                    : conf === "observada" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500";
                  const puedeAprobar = ["borrador", "emitida", "conformada"].includes(l.estado);
                  return (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs">{l.codigo ?? `#${l.id}`}</td>
                      <td className="px-4 py-2">
                        {nombre}
                        {sede && <span className="block text-[11px] text-gray-400">{sede.nombre}</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">{l.periodo ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-bold">{fmtMoneda(Number(l.total ?? 0), l.moneda)}</td>
                      <td className="px-4 py-2">
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-600">{l.estado}</span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${colorConf}`}>{conf}</span>
                        {l.conformidad_por && <span className="block text-[10px] text-gray-400">{l.conformidad_por}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1 justify-end flex-wrap">
                          <button onClick={() => setEditor(l.id)} className="px-2 py-1 rounded-lg text-[11px] font-bold border hover:bg-gray-50">✎ Revisar</button>
                          <button onClick={() => verPdf(l.id)} className="px-2 py-1 rounded-lg text-[11px] font-bold border hover:bg-gray-50">📄 PDF</button>
                          {l.estado !== "borrador" && l.estado !== "anulada" && (
                            <button onClick={() => setEnviar({ ...l, lado })} className="px-2 py-1 rounded-lg text-[11px] font-bold text-white" style={{ background: cp }}>✉ Enviar</button>
                          )}
                          {(l.estado === "emitida" || l.estado === "observada") && (
                            <button onClick={() => reabrir(l)} className="px-2 py-1 rounded-lg text-[11px] font-bold border hover:bg-gray-50">↩ Reabrir</button>
                          )}
                          {puedeAprobar && (
                            <button onClick={() => aprobar(l)} disabled={trabajando}
                              className="px-2 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                              {lado === "cliente" ? "Facturar" : "→ CxP"}
                            </button>
                          )}
                          {l.estado !== "anulada" && !l.factura_id && !l.documento_compra_id && (
                            <button onClick={() => anular(l)} className="px-2 py-1 rounded-lg text-[11px] font-bold border text-red-600 border-red-200 hover:bg-red-50">🗑</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {editor != null && (
        <ModalEditor lado={lado} liquidacionId={editor} usuario={usuario}
          onCerrar={() => setEditor(null)} onCambio={cargarLiquidaciones} onVerPdf={verPdf} />
      )}
      {modalSede && (
        <ModalSede sede={modalSede.sede} clienteNombre={modalSede.cliente}
          onCerrar={() => setModalSede(null)}
          onGuardada={() => { setModalSede(null); cargar(); }} />
      )}
      {enviar && (
        <ModalEnviar liquidacion={enviar} lado={lado}
          sede={sedes.find((s) => s.id === enviar.cliente_sede_id) ?? null}
          contraparte={lado === "cliente" ? clientes[enviar.cliente_id] : terceros[enviar.empresa_tercerizada_id]}
          onCerrar={() => setEnviar(null)}
          onEnviado={() => { setEnviar(null); cargarLiquidaciones(); }} />
      )}
    </div>
  );
}
