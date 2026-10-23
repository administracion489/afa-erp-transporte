"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Pestaña "Adelantos de reservas" (/tesoreria?tab=adelantos) — los traslados que la IA del CRM
// cotizó y el cliente aceptó por WhatsApp, vistos desde Tesorería.
//
// Aquí se hace lo único que la IA y el ejecutivo NO pueden hacer: afirmar que el dinero está en la
// cuenta. Un comprobante (la foto o el PDF que mandó el cliente) es evidencia, no un cobro:
//   · «Registrar adelanto» cuando el depósito se ve en el banco (validado contra el extracto);
//   · «No encontré el pago» si no aparece (el ejecutivo se lo dice al cliente desde el CRM);
//   · «Registrar devolución» cuando la transferencia de una cancelación ya salió.
// Cada comprobante se abre aquí mismo con «👁 Ver» (POST ver_comprobante: enlace firmado de 10 min,
// la misma función que la tarjeta del CRM), sin necesitar el módulo CRM.
//
// La lista y el detalle los arma el servidor (GET /api/reservas/solicitudes, módulo Finanzas o
// Cuentas por Pagar) con la MISMA vista que la tarjeta del CRM, así las dos dicen lo mismo de la
// misma solicitud. Los topes (no pasar del total, no devolver más de lo decidido) los juzga el
// servidor y su motivo se enseña tal cual. Esta pestaña no le escribe al cliente.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useState } from "react";
import { usePuedeVer } from "@/lib/usePuedeVer";
import type { AccionDinero, FilaTesoreria, ResultadoAccionReserva, VistaSolicitud } from "@/lib/traslados/reserva-solicitud-tipos";
import FormCobro from "@/components/reservas/FormCobro";
import { AvisosVista, BloqueDinero, ChipEstado, ListaComprobantes, ListaPagos, ListaPendientes, PoliticaReserva } from "@/components/reservas/DetalleSolicitud";
import {
  ETIQUETA_ACCION, QUIEN_PENDIENTE, accionTesoreria, dinero, fechaDdMm, fechaHoraLima, horaCorta, leerListaTesoreria, leerVistaTesoreria,
  preguntaAdelanto, preguntaDevolucion, preguntaPagoNoEncontrado, textoFallo,
} from "@/components/reservas/reserva-traslado-pantalla";

type Lista = { filas: FilaTesoreria[]; sinMigracion: boolean; avisos: string[] };
const MODULOS_ENLACE = ["crm"] as const;
const SQL_RESERVA = "supabase/reservas-09a-solicitudes.sql, reservas-09b-comprobantes.sql, reservas-09c-pagos-solicitud.sql y traslados-09-reserva-ia.sql";

export default function AdelantosReservasTab() {
  const [filtro, setFiltro] = useState<"pendientes" | "todas">("pendientes");
  const [lista, setLista] = useState<{ filtro: string; n: number; datos: Lista | null; error: string | null } | null>(null);
  const [pedido, setPedido] = useState(0);
  const [abierta, setAbierta] = useState<number | null>(null);
  const puedeVer = usePuedeVer(MODULOS_ENLACE);

  useEffect(() => {
    let vivo = true;
    const n = pedido;
    leerListaTesoreria(filtro).then((r) => {
      if (!vivo) return;
      setLista((prev) => (r.ok
        ? { filtro, n, datos: r.datos, error: null }
        : { filtro, n, datos: prev?.filtro === filtro ? prev.datos : null, error: r.detalle }));
    });
    return () => { vivo = false; };
  }, [filtro, pedido]);
  const recargar = useCallback(() => setPedido((x) => x + 1), []);

  const cargando = !lista || lista.n !== pedido || lista.filtro !== filtro;
  const datos = lista?.filtro === filtro ? lista.datos : null;

  return (
    <main className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-black text-[#0b315f]">💳 Adelantos de reservas</h1>
          <p className="text-sm text-gray-500 max-w-3xl">
            Traslados que el cliente aceptó por WhatsApp con la IA del CRM. Registra el adelanto solo cuando el dinero se vea en el banco:
            el comprobante que mandó el cliente es evidencia, no un cobro. Si no lo encuentras, márcalo y el ejecutivo se lo dice al cliente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-gray-200 overflow-hidden text-xs font-bold">
            {(["pendientes", "todas"] as const).map((f) => (
              <button key={f} type="button" onClick={() => { setFiltro(f); setAbierta(null); }}
                className={`px-3 py-2 min-h-[40px] ${filtro === f ? "bg-[#0b315f] text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                {f === "pendientes" ? "Le toca a Tesorería" : "Todas"}
              </button>
            ))}
          </div>
          <button type="button" onClick={recargar} disabled={cargando}
            className="px-3 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40 min-h-[40px]">
            {cargando ? "Cargando…" : "↻ Actualizar"}
          </button>
        </div>
      </div>

      {lista?.error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          {datos ? "No se pudo volver a leer la lista (lo de abajo es de la última lectura): " : "No se pudieron leer las solicitudes: "}{lista.error}{" "}
          <button type="button" onClick={recargar} className="underline font-semibold">Reintentar</button>
        </div>
      )}
      {datos?.sinMigracion && (
        <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          La reserva de traslados por la IA todavía no está instalada en la base: falta correr {SQL_RESERVA} en Supabase. Hasta entonces no hay solicitudes que mirar.
        </div>
      )}
      {datos && datos.avisos.length > 0 && (
        <ul className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 space-y-0.5">
          {datos.avisos.map((a, i) => <li key={i}>⚠ {a}</li>)}
        </ul>
      )}

      {!datos ? (
        !lista?.error && <p className="text-sm text-gray-400">Cargando las solicitudes…</p>
      ) : datos.filas.length === 0 && !datos.sinMigracion ? (
        <p className="text-sm text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-3 py-4 text-center">
          {filtro === "pendientes" ? "No hay pagos por verificar ni devoluciones por registrar." : "Todavía no hay solicitudes de reserva de traslado."}
        </p>
      ) : (
        <div className="space-y-2">
          {datos.filas.map((f) => (
            <FilaSolicitud key={f.solicitudId} f={f} abierta={abierta === f.solicitudId}
              onAbrir={() => setAbierta(abierta === f.solicitudId ? null : f.solicitudId)}
              puedeCrm={puedeVer ? !!puedeVer.crm : null} onCambio={recargar} />
          ))}
        </div>
      )}
    </main>
  );
}

function FilaSolicitud({ f, abierta, onAbrir, puedeCrm, onCambio }: {
  f: FilaTesoreria; abierta: boolean; onAbrir: () => void; puedeCrm: boolean | null; onCambio: () => void;
}) {
  const m = f.moneda;
  const cuando = [fechaDdMm(f.servicio.fecha), horaCorta(f.servicio.hora)].filter((x) => x && x !== "—").join(" ") || "sin fecha";
  return (
    <div className="bg-white border border-gray-200 rounded-xl">
      <button type="button" onClick={onAbrir} className="w-full text-left px-3 py-2.5 hover:bg-gray-50 rounded-xl">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-mono font-bold text-gray-600">{f.numero ? `N° ${f.numero}` : `Solicitud #${f.solicitudId}`}</span>
          <ChipEstado estado={f.estado} />
          {f.pagoNoEncontrado && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">pago no encontrado</span>}
          <span className="ml-auto text-xs text-gray-400">{abierta ? "▾" : "▸"} {fechaHoraLima(f.creadaEn)}</span>
        </div>
        <p className="text-sm text-gray-800 mt-0.5 break-words">
          <b>{f.cliente ?? "Cliente sin vincular"}</b> · {cuando} · {f.servicio.origen ?? "—"} → {f.servicio.destino ?? "—"}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600 mt-1">
          <span>Total {dinero(f.total, m)}</span>
          <span>Adelanto {dinero(f.adelanto, m)}</span>
          <span className={f.cobrado > 0 ? "text-green-700 font-semibold" : ""}>Cobrado {dinero(f.cobrado, m)}</span>
          {(f.aDevolver != null || f.devuelto > 0) && <span>Devuelto {dinero(f.devuelto, m)}{f.aDevolver != null ? ` de ${dinero(f.aDevolver, m)}` : ""}</span>}
          <span>
            {f.comprobantes === 0 ? "Sin comprobante" : `${f.comprobantes} ${f.comprobantes === 1 ? "comprobante" : "comprobantes"}`}
            {f.comprobantes > 0 && (f.ultimoMontoSeguro != null
              ? <> · el último dice {dinero(f.ultimoMontoSeguro, m)} (cuadra con el adelanto)</>
              : <> · el último no cuadra solo: míralo</>)}
          </span>
        </div>
        {f.pendientesTesoreria.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {f.pendientesTesoreria.map((p, i) => {
              const q = QUIEN_PENDIENTE[p.quien];
              return (
                <li key={`${p.codigo}-${i}`} className="text-xs text-gray-700 flex items-start gap-1.5">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: q?.color, background: q?.bg }}>{q?.label ?? p.quien}</span>
                  <span className="break-words">{p.detalle}{p.vence ? ` · antes del ${fechaHoraLima(p.vence)}` : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
      </button>
      {abierta && <DetalleTesoreria f={f} puedeCrm={puedeCrm} onCambio={onCambio} />}
    </div>
  );
}

function DetalleTesoreria({ f, puedeCrm, onCambio }: { f: FilaTesoreria; puedeCrm: boolean | null; onCambio: () => void }) {
  const [vista, setVista] = useState<{ n: number; v: VistaSolicitud | null; error: string | null } | null>(null);
  const [pedido, setPedido] = useState(0);
  const [ocupado, setOcupado] = useState<AccionDinero | null>(null);
  const [res, setRes] = useState<ResultadoAccionReserva | null>(null);
  const [form, setForm] = useState<"adelanto" | "devolucion" | null>(null);
  const [viendoId, setViendoId] = useState<number | null>(null);
  const [ahora] = useState(() => Date.now());

  useEffect(() => {
    let vivo = true;
    const n = pedido;
    leerVistaTesoreria(f.solicitudId).then((r) => {
      if (!vivo) return;
      setVista((prev) => (r.ok ? { n, v: r.datos, error: null } : { n, v: prev?.v ?? null, error: r.detalle }));
    });
    return () => { vivo = false; };
  }, [f.solicitudId, pedido]);

  const ejecutar = async (cuerpo: { accion: AccionDinero; monto?: number; fecha?: string; metodo?: string; referencia?: string }): Promise<boolean> => {
    if (ocupado) return false;
    setOcupado(cuerpo.accion); setRes(null);
    const r = await accionTesoreria({ ...cuerpo, solicitud_id: f.solicitudId });
    setOcupado(null);
    setRes(r);
    if (r.vista) { const v = r.vista; setVista((prev) => ({ n: prev?.n ?? 0, v, error: null })); } else setPedido((x) => x + 1);
    if (r.ok) { setForm(null); onCambio(); }
    if (r.codigo === "reclamo_perdido") setPedido((x) => x + 1);
    return r.ok;
  };

  const verComprobante = async (comprobanteId: number) => {
    if (viendoId != null) return;
    // La ventana se abre ANTES del await: abierta después, el navegador la bloquea.
    const w = window.open("", "_blank");
    setViendoId(comprobanteId);
    const r = await accionTesoreria({ accion: "ver_comprobante", solicitud_id: f.solicitudId, comprobante_id: comprobanteId });
    setViendoId(null);
    if (r.ok && r.url) {
      if (w) { w.opener = null; w.location.href = r.url; } else window.open(r.url, "_blank", "noopener,noreferrer");
      setPedido((x) => x + 1); // para que diga «abierto el …»
    } else {
      w?.close();
      setRes(r);
    }
  };

  if (!vista || (!vista.v && vista.n !== pedido)) return <p className="px-3 pb-3 text-xs text-gray-400">Cargando el detalle…</p>;
  if (!vista.v) {
    return (
      <p className="px-3 pb-3 text-xs text-red-700">
        No se pudo leer el detalle: {vista.error}{" "}
        <button type="button" onClick={() => setPedido((x) => x + 1)} className="underline font-semibold">Reintentar</button>
      </p>
    );
  }
  const v = vista.v;
  const m = v.dinero.moneda;
  const tiene = (a: AccionDinero) => v.acciones.includes(a);
  const algo = ocupado != null;
  const enlaceCrm = f.convId ? `/crm?conv=${encodeURIComponent(f.convId)}` : null;

  return (
    <div className="border-t border-gray-100 px-3 py-3 space-y-3">
      {vista.error && <p className="text-xs text-red-700">No se pudo volver a leer el detalle (lo de abajo es de la última lectura): {vista.error}</p>}
      <div className="text-xs text-gray-600 space-y-0.5">
        <p>WhatsApp del cliente: {v.contacto.waId ? `+${v.contacto.waId.replace(/\D/g, "")}` : "sin número"}{v.contacto.nombre ? ` (${v.contacto.nombre})` : ""}</p>
        {v.reserva && <p>Reserva en Programación: #{v.reserva.id} · {v.reserva.estado}</p>}
        {enlaceCrm && puedeCrm !== false && (
          <a href={enlaceCrm} target="_blank" rel="noopener noreferrer" className="text-[#0b315f] underline font-semibold">Abrir la conversación en el CRM ↗</a>
        )}
      </div>
      <div>
        <p className="text-[10px] font-bold uppercase text-gray-400 mb-1">Lo que falta</p>
        <ListaPendientes v={v} ahoraMs={ahora} />
      </div>
      <BloqueDinero v={v} />
      <ListaPagos v={v} />
      <div>
        <p className="text-[10px] font-bold uppercase text-gray-400 mb-1">Comprobantes del cliente</p>
        <ListaComprobantes v={v} viendoId={viendoId}
          onVerComprobante={v.acciones.includes("ver_comprobante") ? (id) => void verComprobante(id) : undefined}
          sinVer="La imagen del comprobante no se puede abrir desde aquí: ábrela desde la conversación del CRM." />
      </div>
      {v.cancelacion && (
        <p className="text-xs text-gray-700">
          Cancelación pedida el {fechaHoraLima(v.cancelacion.pedidaEn)}{v.cancelacion.devolucionPct != null ? ` · se decidió devolver el ${v.cancelacion.devolucionPct} %` : " · el ejecutivo todavía no decidió cuánto se devuelve"}.
          {v.devolucionPlazoH ? ` Plazo para devolver: ${v.devolucionPlazoH} h.` : ""}
        </p>
      )}
      <PoliticaReserva lineas={v.politica} />
      <AvisosVista v={v} />

      {res && (
        <div className={`text-xs rounded-lg border px-2 py-1.5 space-y-0.5 ${res.ok ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-700"}`}>
          <p className="font-semibold break-words">{textoFallo(res.codigo, res.detalle)}</p>
          {res.avisos?.map((a, i) => <p key={i} className="text-amber-900 break-words">⚠ {a}</p>)}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {tiene("registrar_adelanto") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "adelanto" ? null : "adelanto")}
            className="text-xs px-3 py-2 rounded-lg border border-green-200 text-green-800 font-semibold hover:bg-green-50 disabled:opacity-40 min-h-[40px]">
            💰 {ETIQUETA_ACCION.registrar_adelanto}…
          </button>
        )}
        {tiene("pago_no_encontrado") && (
          <button type="button" disabled={algo}
            onClick={() => { if (window.confirm(preguntaPagoNoEncontrado(v))) void ejecutar({ accion: "pago_no_encontrado" }); }}
            className="text-xs px-3 py-2 rounded-lg border border-amber-200 text-amber-800 font-semibold hover:bg-amber-50 disabled:opacity-40 min-h-[40px]">
            {ocupado === "pago_no_encontrado" ? "Marcando…" : ETIQUETA_ACCION.pago_no_encontrado}
          </button>
        )}
        {tiene("registrar_devolucion") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "devolucion" ? null : "devolucion")}
            className="text-xs px-3 py-2 rounded-lg border border-sky-200 text-sky-800 font-semibold hover:bg-sky-50 disabled:opacity-40 min-h-[40px]">
            ↩ {ETIQUETA_ACCION.registrar_devolucion}…
          </button>
        )}
        {!tiene("registrar_adelanto") && !tiene("pago_no_encontrado") && !tiene("registrar_devolucion") && (
          <p className="text-xs text-gray-500">No hay nada de dinero que registrar en esta solicitud.</p>
        )}
      </div>
      {form === "adelanto" && (
        <div className="rounded-lg border border-green-200 bg-green-50/40 p-2">
          <FormCobro titulo="Registrar el adelanto visto en el banco" moneda={m} textoBoton="Registrar adelanto" ocupado={algo}
            pregunta={(d) => preguntaAdelanto(v, d)}
            onRegistrar={(d) => ejecutar({ accion: "registrar_adelanto", ...d })}
            nota={<>Pedido: {v.cotizacion?.adelanto != null ? dinero(v.cotizacion.adelanto, m) : "sin calcular"} · ya cobrado: {dinero(v.dinero.cobrado, m)}. El monto no se precarga con lo que leyó la IA: escribe el que ves en el banco.</>} />
        </div>
      )}
      {form === "devolucion" && (
        <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-2">
          <FormCobro titulo="Registrar la devolución hecha al cliente" moneda={m} textoBoton="Registrar devolución" ocupado={algo} tono="devolucion"
            pregunta={(d) => preguntaDevolucion(v, d)}
            onRegistrar={(d) => ejecutar({ accion: "registrar_devolucion", ...d })}
            nota={<>Corresponde devolver {dinero(v.dinero.aDevolver, m)} · ya devuelto: {dinero(v.dinero.devuelto, m)}.</>} />
        </div>
      )}
    </div>
  );
}
