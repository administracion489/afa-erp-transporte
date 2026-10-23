"use client";
// components/crm/TarjetaReservaTraslado.tsx — La tarjeta de una RESERVA de traslado en la bandeja
// del CRM (la fila de `crm_acciones_ia` con `tipo = 'reserva_traslado'` que deja la IA cuando el
// cliente acepta una cotización de traslado).
//
// Lo que se ve lo arma el SERVIDOR (GET /api/crm/reservas-traslado → `VistaSolicitud`): el estado,
// el plazo para confirmar la unidad, el orden (pago primero / disponibilidad primero) y su porqué,
// el dinero, los comprobantes con el cotejo, lo que falta y de quién es cada cosa, y las acciones
// que tienen sentido HOY. La tarjeta solo pinta y pregunta: no decide qué se puede hacer ni compone
// los mensajes al cliente (los arma el servidor); cada botón tiene su `confirm()` que NOMBRA el
// dinero o el mensaje que va a salir (components/reservas/reserva-traslado-pantalla.ts).
//
// Reglas de la pantalla:
//  · nunca se afirma un vacío mientras se busca («Cargando la solicitud…»);
//  · un fallo al recargar no borra lo que ya se veía: se dice encima;
//  · los botones de dinero —y «Resolver cancelación», que decide cuánto se devuelve— solo salen con el
//    módulo Finanzas o Cuentas por Pagar (`permisos.dinero`); sin él, se dice que eso lo hace Tesorería;
//  · «Hay unidad» / «No hay unidad» se apagan sin el módulo Programación (`permisos.programacion`),
//    diciendo por qué (crean o descartan la reserva ahí);
//  · fuera de la ventana de 24 h de WhatsApp el resultado trae el texto y el enlace wa.me (y el PDF
//    de la Confirmación para descargarlo): queda FIJO en la tarjeta hasta que se oculte.
// El contrato de la ruta es lib/traslados/reserva-solicitud-tipos.ts.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import SelectorCliente from "@/components/SelectorCliente";
import { rotuloCliente, type ClienteBuscable } from "@/lib/clientes-buscador";
import { formatearTelefono, mismoTelefonoE164 } from "@/lib/crm-telefono";
import { nombreArchivo } from "@/lib/confirmacion-reserva";
import {
  enlaceWaMe, type AccionDinero, type AccionTarjeta, type CuerpoTarjeta, type ResultadoAccionReserva, type VistaSolicitud,
} from "@/lib/traslados/reserva-solicitud-tipos";
import FormCobro from "@/components/reservas/FormCobro";
import FormCancelacion from "@/components/reservas/FormCancelacion";
import { AvisosVista, BloqueDinero, ChipEstado, ListaComprobantes, ListaPagos, ListaPendientes, PoliticaReserva } from "@/components/reservas/DetalleSolicitud";
import {
  ETIQUETA_ACCION, MOTIVO_CIERRE_TEXTO, ORDEN_SOLICITUD, accionTarjeta, cuentaRegresiva, dinero,
  fechaDdMm, fechaHoraLima, horaCorta, leerVistaTarjeta, lineaServicio, preguntaAdelanto, preguntaCerrar, preguntaDevolucion,
  preguntaEnviarConfirmacion, preguntaHayUnidad, preguntaMarcarEnviada, preguntaPagoNoEncontrado, preguntaPedirComprobante,
  preguntaRegistrarComprobante, preguntaResolverCancelacion, preguntaSinUnidad, preguntaVincular, telLegible, textoFallo,
  type VistaTarjeta,
} from "@/components/reservas/reserva-traslado-pantalla";

/** Lo que la tarjeta necesita de la fila de `crm_acciones_ia`. */
export type AccionReservaIA = {
  id: string;
  conversacion_id: string;
  payload: unknown;
  resultado_id?: number | null;
  resumen?: string;
  estado: string;
  resuelta_at?: string | null;
};

/** El id de la solicitud que guarda la tarjeta (`payload.solicitud_id`, o `resultado_id`). null si no lo trae. */
export function solicitudDeAccion(a: Pick<AccionReservaIA, "payload" | "resultado_id">): number | null {
  const p = (a.payload && typeof a.payload === "object" ? a.payload : {}) as Record<string, unknown>;
  const n = Number(p.solicitud_id ?? a.resultado_id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const numeroDeAccion = (a: AccionReservaIA): string | null => {
  const p = (a.payload && typeof a.payload === "object" ? a.payload : {}) as Record<string, unknown>;
  return typeof p.numero === "string" && p.numero.trim() ? p.numero.trim() : null;
};

type Accion = AccionTarjeta | AccionDinero;
type Formulario = "cerrar" | "cancelacion" | "vincular" | "confirmacion" | "adelanto" | "devolucion";
type Estado = { n: number; datos: VistaTarjeta | null; error: string | null; codigo: string | null };
type Resultado = ResultadoAccionReserva & { accion: Accion };

const btn = "text-xs px-2.5 py-1.5 rounded-lg border font-semibold disabled:opacity-40 min-h-[36px]";
const btnNeutro = `${btn} border-gray-200 text-gray-700 hover:bg-gray-50`;
const inputCls = "w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 min-h-[40px]";
const SONDEO_MS = 120_000;

export default function TarjetaReservaTraslado({ accion, enBandeja, ultimoMensajeAt, onActuo, onOcultar, onToast }: {
  accion: AccionReservaIA;
  /** false = la solicitud ya salió de la bandeja (se cerró) y la tarjeta sigue porque se acaba de actuar. */
  enBandeja: boolean;
  /** La hora del último mensaje del chat: cuando cambia (el cliente mandó algo, la IA respondió) se relee. */
  ultimoMensajeAt: string | null;
  /** Se actuó sobre la tarjeta: la bandeja la conserva aunque la acción se cierre (para no perder el wa.me). */
  onActuo: (a: AccionReservaIA) => void;
  onOcultar: () => void;
  onToast: (msg: string, ok?: boolean) => void;
}) {
  const solicitudId = solicitudDeAccion(accion);
  const numero = numeroDeAccion(accion);
  const [est, setEst] = useState<Estado | null>(null);
  const [pedido, setPedido] = useState(0);
  const [ahora, setAhora] = useState(() => Date.now());
  const [ocupado, setOcupado] = useState<Accion | "pdf" | null>(null);
  const [res, setRes] = useState<Resultado | null>(null);
  const [form, setForm] = useState<Formulario | null>(null);
  const [avisoPdf, setAvisoPdf] = useState<string | null>(null);
  const pid = useRef(0);
  const pedidoRef = useRef(pedido);
  const ocupadoRef = useRef(ocupado);
  useEffect(() => { pedidoRef.current = pedido; }, [pedido]);
  useEffect(() => { ocupadoRef.current = ocupado; }, [ocupado]);

  // ── La vista ──
  useEffect(() => {
    if (!solicitudId) return;
    const mio = ++pid.current;
    const n = pedido;
    leerVistaTarjeta({ solicitudId, conversacionId: accion.conversacion_id, accionId: accion.id }).then((r) => {
      if (mio !== pid.current) return;
      setEst((prev) => (r.ok
        ? { n, datos: r.datos, error: null, codigo: null }
        // Un fallo al RECARGAR no borra lo que ya se veía.
        : { n, datos: prev?.datos ?? null, error: r.detalle, codigo: r.codigo }));
    });
  }, [solicitudId, accion.id, accion.conversacion_id, pedido]);

  const recargar = useCallback(() => setPedido((x) => x + 1), []);

  // El reloj del plazo, el sondeo (con la pestaña visible) y la relectura cuando el chat o la fila cambian.
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 30_000);
    const s = setInterval(() => { if (document.visibilityState === "visible" && !ocupadoRef.current) recargar(); }, SONDEO_MS);
    return () => { clearInterval(t); clearInterval(s); };
  }, [recargar]);
  const primerMsg = useRef(ultimoMensajeAt);
  useEffect(() => {
    if (!ultimoMensajeAt || ultimoMensajeAt === primerMsg.current) return;
    const t = setTimeout(recargar, 2500);
    return () => clearTimeout(t);
  }, [ultimoMensajeAt, recargar]);
  const firmaFila = `${accion.estado}|${accion.resuelta_at ?? ""}|${JSON.stringify(accion.payload ?? null)}`;
  const primeraFirma = useRef(firmaFila);
  useEffect(() => {
    if (firmaFila === primeraFirma.current) return;
    const t = setTimeout(recargar, 800);
    return () => clearTimeout(t);
  }, [firmaFila, recargar]);

  // ── Las acciones ──
  const ejecutar = async (cuerpo: Omit<CuerpoTarjeta, "solicitud_id" | "conversacion_id" | "accion_id">, x: { silencioso?: boolean } = {}): Promise<ResultadoAccionReserva | null> => {
    if (!solicitudId || ocupadoRef.current) return null;
    ocupadoRef.current = cuerpo.accion; // un doble clic no manda la acción dos veces
    setOcupado(cuerpo.accion);
    if (!x.silencioso) setRes(null);
    setAvisoPdf(null);
    const r = await accionTarjeta({ ...cuerpo, solicitud_id: solicitudId, conversacion_id: accion.conversacion_id, accion_id: accion.id });
    ocupadoRef.current = null;
    setOcupado(null);
    if (!x.silencioso || !r.ok) setRes({ ...r, accion: cuerpo.accion });
    if (r.vista) {
      ++pid.current; // una lectura que venía en camino es de ANTES de la acción
      const vista = r.vista;
      setEst((prev) => ({ n: pedidoRef.current, datos: { vista, permisos: prev?.datos?.permisos ?? null }, error: null, codigo: null }));
    } else recargar();
    onActuo(accion);
    if (r.ok && r.codigo === "ok" && !x.silencioso) onToast(r.detalle, true);
    if (r.ok) setForm(null);
    return r;
  };

  const verComprobante = async () => {
    // La ventana se abre ANTES del await: abierta después, el navegador la bloquea.
    const w = window.open("", "_blank");
    const r = await ejecutar({ accion: "ver_comprobante" }, { silencioso: true });
    if (r?.ok && r.url) {
      if (w) { w.opener = null; w.location.href = r.url; } else window.open(r.url, "_blank", "noopener,noreferrer");
    } else w?.close();
  };

  const descargarPdf = async (url: string, codigo: string, idioma: "es" | "en") => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = "pdf";
    setOcupado("pdf"); setAvisoPdf(null);
    try {
      const r = await fetch(url, { headers: await cabecerasErp() });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { detalle?: string; error?: string } | null;
        throw new Error(j?.detalle || j?.error || (r.status === 403 ? "Te falta el módulo Programación para descargar la Confirmación." : `El servidor respondió ${r.status} sin el PDF.`));
      }
      const b = await r.blob();
      const href = URL.createObjectURL(b);
      const a = document.createElement("a"); a.href = href; a.download = nombreArchivo(codigo, idioma); a.click();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch (e) {
      setAvisoPdf(`No se pudo descargar el PDF: ${(e as Error)?.message ?? "sin conexión"}`);
    }
    ocupadoRef.current = null;
    setOcupado(null);
  };

  // ── Sin solicitud, o cargando ──
  if (!solicitudId) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-3 space-y-1">
        <div className="text-[11px] font-semibold text-red-700 uppercase tracking-wide">📅 Reserva de traslado</div>
        {accion.resumen && <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{accion.resumen}</p>}
        <p className="text-xs text-red-700">Esta tarjeta no trae el número de su solicitud de reserva: no se puede abrir desde aquí. Avisa a sistemas con la conversación.</p>
      </div>
    );
  }
  const datos = est?.datos ?? null;
  const cargando = !est || est.n !== pedido;

  if (!datos) {
    return (
      <div className="bg-white border border-amber-200 rounded-xl p-3 space-y-1.5">
        <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">📅 Reserva de traslado{numero ? ` · cotización N° ${numero}` : ""}</div>
        {accion.resumen && <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{accion.resumen}</p>}
        {cargando || !est?.error ? (
          <p className="text-xs text-gray-500">Cargando la solicitud…</p>
        ) : (
          <div className={`text-xs rounded-lg px-2 py-1.5 border ${est.codigo === "sin_migracion" ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-red-50 border-red-200 text-red-700"}`}>
            {est.error}{" "}
            <button type="button" onClick={recargar} className="underline font-semibold">Reintentar</button>
          </div>
        )}
      </div>
    );
  }

  const v = datos.vista;
  const permisos = datos.permisos;
  const tiene = (a: Accion) => v.acciones.includes(a);
  const c = v.cotizacion;
  const m = v.dinero.moneda;
  const terminal = v.estado === "sin_unidad" || v.estado === "cancelada" || v.estado === "completada";
  const plazo = !terminal && v.estado !== "confirmada" ? cuentaRegresiva(v.confirmarAntesDe, ahora) : null;
  const algo = ocupado != null;
  const dineroAcciones = (["registrar_adelanto", "pago_no_encontrado", "registrar_devolucion"] as const).filter(tiene);
  const puedeDinero = permisos?.dinero === true;
  const sinProgramacion = permisos?.programacion === false;
  const reservaViva = v.reserva && v.reserva.estado !== "cancelada" ? v.reserva : null;

  const preguntarY = (pregunta: string, cuerpo: Omit<CuerpoTarjeta, "solicitud_id" | "conversacion_id" | "accion_id">) => {
    if (algo) return;
    if (!window.confirm(pregunta)) return;
    void ejecutar(cuerpo);
  };

  return (
    <div className="bg-white border border-amber-200 rounded-xl p-3 space-y-2.5">
      {/* Cabecera */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">📅 Reserva de traslado</div>
        {c?.numero && <div className="text-[11px] font-mono font-bold text-gray-600">N° {c.numero}</div>}
        <ChipEstado estado={v.estado} />
        {v.urgente && !terminal && <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-red-100 text-red-700">URGENTE</span>}
        <span className="ml-auto flex items-center gap-2">
          {cargando && <span className="text-[10px] text-gray-400">actualizando…</span>}
          <button type="button" onClick={recargar} disabled={cargando} title="Volver a leer la solicitud"
            className="text-[11px] px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 min-h-[32px]">↻</button>
          {!enBandeja && (
            <button type="button" onClick={onOcultar} className="text-[11px] px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 min-h-[32px]">Ocultar</button>
          )}
        </span>
      </div>
      {!enBandeja && (
        <p className="text-[11px] text-gray-500">La solicitud ya salió de la bandeja (quedó cerrada). La tarjeta sigue aquí porque acabas de actuar sobre ella; al ocultarla o cambiar de página no vuelve.</p>
      )}
      {est?.error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5 break-words">
          No se pudo volver a leer la solicitud (lo de abajo es de la última lectura): {est.error}
        </p>
      )}

      {/* El servicio */}
      <div className="text-xs text-gray-700 space-y-0.5 break-words">
        <p><span className="text-gray-500">Servicio:</span> {lineaServicio(c)}</p>
        {c && (c.fechaRetorno || c.horaRetorno) && (
          <p><span className="text-gray-500">Retorno:</span> {[fechaDdMm(c.fechaRetorno), horaCorta(c.horaRetorno)].filter((x) => x && x !== "—").join(" ") || "sin fecha"}</p>
        )}
        <p>
          <span className="text-gray-500">Cliente del ERP:</span> {v.cliente ? v.cliente.nombre : <span className="text-amber-800">sin vincular</span>}
          {" · "}<span className="text-gray-500">WhatsApp:</span> {telLegible(v.contacto.waId)}{v.contacto.nombre ? ` (${v.contacto.nombre})` : ""}
        </p>
        {(v.nombrePasajero || v.vuelo) && (
          <p>{v.nombrePasajero && <><span className="text-gray-500">Pasajero:</span> {v.nombrePasajero}</>}{v.nombrePasajero && v.vuelo ? " · " : ""}{v.vuelo && <><span className="text-gray-500">Vuelo:</span> {v.vuelo}</>}</p>
        )}
        {v.nota && <p><span className="text-gray-500">Nota:</span> {v.nota}</p>}
        {v.reserva ? (
          <p>
            <span className="text-gray-500">Reserva en Programación:</span> #{v.reserva.id} · {v.reserva.estado} · {v.reserva.tramos} {v.reserva.tramos === 1 ? "tramo" : "tramos"}{" "}
            <a href={`/programacion?editar=${v.reserva.id}`} target="_blank" rel="noopener noreferrer" className="text-[#0b315f] underline font-semibold">Abrir ↗</a>
          </p>
        ) : !terminal ? <p className="text-gray-500">Todavía no hay reserva en Programación (se crea con «✅ Hay unidad»).</p> : null}
        <p className="text-gray-500">
          {v.ventana.abierta
            ? `WhatsApp: se le puede escribir por el CRM hasta el ${fechaHoraLima(v.ventana.cierraEn)}.`
            : v.ventana.ultimoEntrante
              ? `WhatsApp: pasaron más de 24 h desde su último mensaje (${fechaHoraLima(v.ventana.ultimoEntrante)}): lo que se le escriba sale por wa.me desde el celular.`
              : "WhatsApp: el cliente no tiene mensajes en este chat: lo que se le escriba sale por wa.me desde el celular."}
        </p>
      </div>

      {/* El plazo y el orden */}
      {plazo && (
        <p className={`text-xs font-semibold rounded-lg px-2 py-1.5 border ${plazo.vencido || v.urgente ? "bg-red-50 border-red-200 text-red-700" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
          ⏱ Confirmar la unidad antes del {fechaHoraLima(v.confirmarAntesDe)} · {plazo.texto}
        </p>
      )}
      <div className="text-xs text-gray-600">
        <p>{ORDEN_SOLICITUD[v.orden] ?? v.orden}</p>
        {v.motivos.length > 0 && <ul className="list-disc pl-4 space-y-0.5 mt-0.5">{v.motivos.map((x, i) => <li key={`${x.codigo}-${i}`} className="break-words">{x.texto}</li>)}</ul>}
      </div>

      {/* Lo que falta */}
      <div>
        <p className="text-[10px] font-bold uppercase text-gray-400 mb-1">Lo que falta</p>
        <ListaPendientes v={v} ahoraMs={ahora} />
      </div>

      {/* El dinero */}
      <BloqueDinero v={v} />
      <ListaPagos v={v} />
      {v.pagoNoEncontrado && (
        <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
          Tesorería no encontró en el banco el pago reportado ({fechaHoraLima(v.pagoNoEncontrado.at)}{v.pagoNoEncontrado.por ? `, ${v.pagoNoEncontrado.por}` : ""}).
        </p>
      )}
      {v.cancelacion && (
        <p className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5">
          El cliente pidió cancelar el {fechaHoraLima(v.cancelacion.pedidaEn)}
          {v.cancelacion.horasAntes != null ? `, ${v.cancelacion.horasAntes} h antes del inicio del servicio` : " (sin hora de servicio para contar la anticipación)"}
          {v.cancelacion.devolucionPct != null ? ` · se decidió devolver el ${v.cancelacion.devolucionPct} %` : " · falta decidir cuánto se devuelve"}.
        </p>
      )}
      {v.cargo && (
        <p className="text-xs text-gray-700">
          Comprobante del cargo retenido: {v.cargo.serie && v.cargo.numero ? `${v.cargo.serie}-${v.cargo.numero}` : "sin número (lo emite Facturación)"}{v.cargo.total != null ? ` · ${dinero(v.cargo.total, m)}` : ""}{v.cargo.estado ? ` · ${v.cargo.estado}` : ""}
        </p>
      )}
      {v.confirmacion.emitida && (
        <p className="text-xs text-gray-700">
          Confirmación de Reserva: {v.confirmacion.ultima ? `versión ${v.confirmacion.ultima.version} (${v.confirmacion.ultima.codigo})` : "emitida"} · {v.confirmacion.enviada ? "enviada" : "todavía no enviada"}
        </p>
      )}
      {terminal && (v.cierreMotivo || v.cerradaEn) && (
        <p className="text-xs text-gray-500">Cerrada{v.cerradaEn ? ` el ${fechaHoraLima(v.cerradaEn)}` : ""}{v.cierreMotivo ? ` · ${MOTIVO_CIERRE_TEXTO[v.cierreMotivo as keyof typeof MOTIVO_CIERRE_TEXTO] ?? v.cierreMotivo}` : ""}.</p>
      )}

      {/* Los comprobantes */}
      <div>
        <p className="text-[10px] font-bold uppercase text-gray-400 mb-1">Comprobantes del cliente</p>
        <ListaComprobantes v={v} onVer={tiene("ver_comprobante") ? () => void verComprobante() : undefined} viendo={ocupado === "ver_comprobante"} />
      </div>
      <PoliticaReserva lineas={v.politica} />
      <AvisosVista v={v} />

      {/* El resultado de la última acción (fijo hasta la siguiente) */}
      {res && <ResultadoBloque r={res} v={v} ocupado={algo} onPdf={(url, cod, idioma) => void descargarPdf(url, cod, idioma)}
        puedeMarcar={tiene("marcar_confirmacion_enviada")} onMarcar={() => preguntarY(preguntaMarcarEnviada(v), { accion: "marcar_confirmacion_enviada" })}
        onCerrar={() => setRes(null)} />}
      {avisoPdf && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5 break-words">{avisoPdf}</p>}

      {/* Las acciones */}
      <div className="flex flex-wrap gap-1.5">
        {tiene("hay_unidad") && (
          <button type="button" disabled={algo || sinProgramacion} onClick={() => preguntarY(preguntaHayUnidad(v), { accion: "hay_unidad" })}
            className={`${btn} border-green-700 bg-green-700 text-white hover:bg-green-800`}>
            {ocupado === "hay_unidad" ? "Confirmando…" : ETIQUETA_ACCION.hay_unidad}
          </button>
        )}
        {tiene("sin_unidad") && (
          <button type="button" disabled={algo || sinProgramacion} onClick={() => preguntarY(preguntaSinUnidad(v), { accion: "sin_unidad" })}
            className={`${btn} border-red-200 text-red-700 hover:bg-red-50`}>
            {ocupado === "sin_unidad" ? "Cerrando…" : ETIQUETA_ACCION.sin_unidad}
          </button>
        )}
        {tiene("registrar_comprobante") && (
          <button type="button" disabled={algo} onClick={() => preguntarY(preguntaRegistrarComprobante(v), { accion: "registrar_comprobante" })} className={btnNeutro}>
            {ocupado === "registrar_comprobante" ? "Leyendo el comprobante…" : ETIQUETA_ACCION.registrar_comprobante}
          </button>
        )}
        {tiene("pedir_comprobante") && (
          <button type="button" disabled={algo} onClick={() => preguntarY(preguntaPedirComprobante(v, "otro"), { accion: "pedir_comprobante", motivo: "otro" })} className={btnNeutro}>
            {ocupado === "pedir_comprobante" ? "Pidiendo…" : ETIQUETA_ACCION.pedir_comprobante}
          </button>
        )}
        {tiene("pedir_comprobante") && v.pagoNoEncontrado && (
          <button type="button" disabled={algo} onClick={() => preguntarY(preguntaPedirComprobante(v, "no_encontrado"), { accion: "pedir_comprobante", motivo: "no_encontrado" })} className={btnNeutro}>
            Decirle que no encontramos el pago
          </button>
        )}
        {puedeDinero && tiene("resolver_cancelacion") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "cancelacion" ? null : "cancelacion")} className={`${btnNeutro} ${form === "cancelacion" ? "bg-gray-100" : ""}`}>
            {ETIQUETA_ACCION.resolver_cancelacion}…
          </button>
        )}
        {tiene("vincular_cliente") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "vincular" ? null : "vincular")} className={`${btnNeutro} ${form === "vincular" ? "bg-gray-100" : ""}`}>
            {v.cliente ? "Cambiar cliente vinculado…" : `${ETIQUETA_ACCION.vincular_cliente}…`}
          </button>
        )}
        {tiene("enviar_confirmacion") && (
          <button type="button" disabled={algo || sinProgramacion} onClick={() => setForm(form === "confirmacion" ? null : "confirmacion")}
            className={`${btn} border-[#0b315f] bg-[#0b315f] text-white hover:bg-[#1262bd]`}>
            {ETIQUETA_ACCION.enviar_confirmacion}…
          </button>
        )}
        {tiene("marcar_confirmacion_enviada") && !v.ventana.abierta && v.confirmacion.ultima && !sinProgramacion && (
          <button type="button" disabled={algo} onClick={() => void descargarPdf(`/api/reservas/confirmacion?version_id=${v.confirmacion.ultima!.id}&idioma=es&pdf=1`, v.confirmacion.ultima!.codigo, "es")} className={btnNeutro}>
            {ocupado === "pdf" ? "Descargando…" : `⬇ PDF ${v.confirmacion.ultima.codigo}`}
          </button>
        )}
        {tiene("marcar_confirmacion_enviada") && (
          <button type="button" disabled={algo} onClick={() => preguntarY(preguntaMarcarEnviada(v), { accion: "marcar_confirmacion_enviada" })} className={btnNeutro}>
            {ocupado === "marcar_confirmacion_enviada" ? "Marcando…" : `${ETIQUETA_ACCION.marcar_confirmacion_enviada} (por wa.me)`}
          </button>
        )}
        {tiene("cerrar") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "cerrar" ? null : "cerrar")} className={`${btn} border-gray-200 text-gray-500 hover:bg-gray-50 ${form === "cerrar" ? "bg-gray-100" : ""}`}>
            {ETIQUETA_ACCION.cerrar}…
          </button>
        )}
        {puedeDinero && tiene("registrar_adelanto") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "adelanto" ? null : "adelanto")} className={`${btn} border-green-200 text-green-800 hover:bg-green-50 ${form === "adelanto" ? "bg-green-50" : ""}`}>
            💰 {ETIQUETA_ACCION.registrar_adelanto}…
          </button>
        )}
        {puedeDinero && tiene("pago_no_encontrado") && (
          <button type="button" disabled={algo} onClick={() => preguntarY(preguntaPagoNoEncontrado(v), { accion: "pago_no_encontrado" })} className={`${btn} border-amber-200 text-amber-800 hover:bg-amber-50`}>
            {ocupado === "pago_no_encontrado" ? "Marcando…" : ETIQUETA_ACCION.pago_no_encontrado}
          </button>
        )}
        {puedeDinero && tiene("registrar_devolucion") && (
          <button type="button" disabled={algo} onClick={() => setForm(form === "devolucion" ? null : "devolucion")} className={`${btn} border-sky-200 text-sky-800 hover:bg-sky-50 ${form === "devolucion" ? "bg-sky-50" : ""}`}>
            ↩ {ETIQUETA_ACCION.registrar_devolucion}…
          </button>
        )}
      </div>
      {tiene("enviar_confirmacion") && sinProgramacion && (
        <p className="text-[11px] text-gray-500">«{ETIQUETA_ACCION.enviar_confirmacion}» exige además el módulo Programación (lo da un administrador en Usuarios).</p>
      )}
      {(tiene("hay_unidad") || tiene("sin_unidad")) && sinProgramacion && (
        <p className="text-[11px] text-gray-500">«{ETIQUETA_ACCION.hay_unidad}» y «{ETIQUETA_ACCION.sin_unidad}» los confirma quien opera la flota: exigen además el módulo Programación (crean o descartan la reserva ahí).</p>
      )}
      {tiene("resolver_cancelacion") && !puedeDinero && (
        <p className="text-[11px] text-gray-500">
          Cuánto se le devuelve al cliente lo decide Tesorería (módulo Finanzas o Cuentas por Pagar): aquí o en Tesorería → Adelantos de reservas.
          {permisos == null ? " No se pudo saber si tienes ese módulo." : ""}
        </p>
      )}
      {dineroAcciones.length > 0 && !puedeDinero && (
        <p className="text-[11px] text-gray-500">
          {dineroAcciones.map((a) => `«${ETIQUETA_ACCION[a]}»`).join(", ")}: lo hace Tesorería (módulo Finanzas o Cuentas por Pagar), en Tesorería → Adelantos de reservas.
          {permisos == null ? " No se pudo saber si tienes ese módulo." : ""}
        </p>
      )}
      {terminal && v.acciones.length === 0 && <p className="text-[11px] text-gray-500">No queda nada por hacer en esta solicitud.</p>}

      {/* Los formularios */}
      {form === "cerrar" && <FormCerrar v={v} ocupado={algo} onCancelar={() => setForm(null)} onCerrar={(motivo, nota) => preguntarY(preguntaCerrar(v, motivo), { accion: "cerrar", motivo, nota: nota || undefined })} />}
      {form === "cancelacion" && puedeDinero && (
        <FormCancelacion v={v} reservaViva={reservaViva} ocupado={algo} onCancelar={() => setForm(null)}
          onResolver={(pct) => preguntarY(preguntaResolverCancelacion(v, pct), { accion: "resolver_cancelacion", devolucion_pct: pct })} />
      )}
      {form === "vincular" && (
        <FormVincular v={v} ocupado={algo} onCancelar={() => setForm(null)}
          onVincular={(cli) => preguntarY(preguntaVincular(v, { nombre: rotuloCliente(cli), telefono: cli.telefono }), { accion: "vincular_cliente", cliente_id: cli.id })} />
      )}
      {form === "confirmacion" && (
        <FormConfirmacion v={v} ocupado={algo} sinProgramacion={sinProgramacion} onCancelar={() => setForm(null)}
          onEnviar={(idioma, extras) => preguntarY(preguntaEnviarConfirmacion(v, { idioma, telefonoConductor: !!extras.incluir_telefono_conductor }), { accion: "enviar_confirmacion", idioma, extras })} />
      )}
      {form === "adelanto" && puedeDinero && (
        <div className="rounded-lg border border-green-200 bg-green-50/40 p-2">
          <FormCobro titulo="Registrar el adelanto visto en el banco" moneda={m} textoBoton="Registrar adelanto" ocupado={algo}
            pregunta={(d) => preguntaAdelanto(v, d)}
            onRegistrar={async (d) => !!(await ejecutar({ accion: "registrar_adelanto", ...d }))?.ok}
            nota={<>Pedido: {c?.adelanto != null ? dinero(c.adelanto, m) : "sin calcular"} · ya cobrado: {dinero(v.dinero.cobrado, m)}. El monto no se precarga con lo que leyó la IA: escribe el que ves en el banco.</>} />
        </div>
      )}
      {form === "devolucion" && puedeDinero && (
        <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-2">
          <FormCobro titulo="Registrar la devolución hecha al cliente" moneda={m} textoBoton="Registrar devolución" ocupado={algo} tono="devolucion"
            pregunta={(d) => preguntaDevolucion(v, d)}
            onRegistrar={async (d) => !!(await ejecutar({ accion: "registrar_devolucion", ...d }))?.ok}
            nota={<>Corresponde devolver {dinero(v.dinero.aDevolver, m)} · ya devuelto: {dinero(v.dinero.devuelto, m)}.</>} />
        </div>
      )}
    </div>
  );
}

// ── El resultado de una acción ───────────────────────────────────────────────

function ResultadoBloque({ r, v, ocupado, onPdf, puedeMarcar, onMarcar, onCerrar }: {
  r: Resultado; v: VistaSolicitud; ocupado: boolean;
  onPdf: (url: string, codigo: string, idioma: "es" | "en") => void;
  puedeMarcar: boolean; onMarcar: () => void; onCerrar: () => void;
}) {
  const [copiado, setCopiado] = useState(false);
  const fuera = r.codigo === "fuera_de_ventana" ? r.fueraDeVentana ?? null : null;
  const fallidoTexto = r.codigo === "envio_fallido" ? r.mensaje ?? null : null;
  const texto = fuera?.texto ?? fallidoTexto;
  const waMe = fuera ? fuera.waMe : fallidoTexto ? enlaceWaMe(v.contacto.waId, fallidoTexto) : null;
  const idiomaPdf = (u: string): "es" | "en" => {
    try { return new URL(u, window.location.origin).searchParams.get("idioma") === "en" ? "en" : "es"; } catch { return "es"; }
  };
  const copiar = async () => {
    if (!texto) return;
    try { await navigator.clipboard.writeText(texto); setCopiado(true); setTimeout(() => setCopiado(false), 2500); } catch { setCopiado(false); }
  };
  const tono = r.ok && r.codigo === "ok" ? "border-green-200 bg-green-50 text-green-800"
    : r.codigo === "fuera_de_ventana" ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-red-200 bg-red-50 text-red-700";
  return (
    <div className={`rounded-lg border p-2 space-y-1.5 text-xs ${tono}`}>
      <div className="flex items-start gap-2">
        <p className="font-semibold break-words flex-1">
          {r.codigo === "envio_fallido" ? `Se hizo en el ERP, pero el mensaje al cliente no salió: ${r.detalle}` : textoFallo(r.codigo, r.detalle)}
        </p>
        <button type="button" onClick={onCerrar} className="text-[11px] underline opacity-70 hover:opacity-100 flex-shrink-0">quitar</button>
      </div>
      {fuera && (
        <p>{r.bloqueos?.some((b) => b.codigo === "cliente_no_verificado")
          ? "Por el CRM no salió nada: el cliente de la reserva no está verificado para este chat (el motivo va abajo). Si es el mismo cliente, envíaselo tú desde el celular:"
          : fuera.cerroEn
          ? `Por el CRM no salió nada: la ventana de 24 h de WhatsApp se cerró el ${fechaHoraLima(fuera.cerroEn)}. Envíaselo tú desde el celular:`
          : "Por el CRM no salió nada (la conversación no es de WhatsApp, no tiene número o no se pudo leer la ventana de 24 h). Envíaselo tú desde el celular:"}</p>
      )}
      {texto && (
        <>
          <p className="whitespace-pre-wrap break-words bg-white border border-gray-200 rounded-lg p-2 text-gray-800">{texto}</p>
          <div className="flex flex-wrap gap-1.5">
            {waMe ? (
              <a href={waMe} target="_blank" rel="noopener noreferrer" className={`${btn} border-green-700 bg-green-700 text-white inline-flex items-center`}>Abrir WhatsApp con el texto ↗</a>
            ) : <span className="text-[11px]">No hay un número de WhatsApp válido para armar el enlace: copia el texto.</span>}
            <button type="button" onClick={() => void copiar()} className={btnNeutro}>{copiado ? "Copiado ✓" : "Copiar texto"}</button>
          </div>
        </>
      )}
      {r.version && (
        <div className="space-y-1">
          <p>Confirmación {r.version.codigo} (versión {r.version.version}) emitida. Descárgala y adjúntala en el chat de WhatsApp del cliente; después márcala como enviada.</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={ocupado} onClick={() => onPdf(r.version!.pdf, r.version!.codigo, idiomaPdf(r.version!.pdf))} className={btnNeutro}>⬇ Descargar PDF</button>
            {puedeMarcar && <button type="button" disabled={ocupado} onClick={onMarcar} className={btnNeutro}>{ETIQUETA_ACCION.marcar_confirmacion_enviada}</button>}
          </div>
        </div>
      )}
      {r.enviado && r.mensaje && (
        <details>
          <summary className="cursor-pointer text-[11px] underline">Ver el mensaje que le salió al cliente</summary>
          <p className="whitespace-pre-wrap break-words bg-white border border-gray-200 rounded-lg p-2 mt-1 text-gray-800">{r.mensaje}</p>
        </details>
      )}
      {r.bloqueos && r.bloqueos.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5">{r.bloqueos.map((b, i) => <li key={`${b.codigo}-${i}`} className="break-words">{b.detalle}</li>)}</ul>
      )}
      {r.avisos && r.avisos.length > 0 && (
        <ul className="text-amber-900 space-y-0.5">{r.avisos.map((a, i) => <li key={i} className="break-words">⚠ {a}</li>)}</ul>
      )}
    </div>
  );
}

// ── Los formularios ──────────────────────────────────────────────────────────

function Caja({ titulo, children, onCancelar }: { titulo: string; children: ReactNode; onCancelar: () => void }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-bold uppercase text-gray-500 flex-1">{titulo}</p>
        <button type="button" onClick={onCancelar} className="text-[11px] text-gray-500 underline">cancelar</button>
      </div>
      {children}
    </div>
  );
}

function FormCerrar({ v, ocupado, onCancelar, onCerrar }: {
  v: VistaSolicitud; ocupado: boolean; onCancelar: () => void; onCerrar: (motivo: keyof typeof MOTIVO_CIERRE_TEXTO, nota: string) => void;
}) {
  const [motivo, setMotivo] = useState<keyof typeof MOTIVO_CIERRE_TEXTO | null>(null);
  const [nota, setNota] = useState("");
  const falta = !motivo ? "Elige el motivo del cierre." : null;
  return (
    <Caja titulo={`Cerrar la solicitud #${v.id}`} onCancelar={onCancelar}>
      <div className="space-y-1">
        {(Object.keys(MOTIVO_CIERRE_TEXTO) as (keyof typeof MOTIVO_CIERRE_TEXTO)[]).map((k) => (
          <label key={k} className="flex items-center gap-2 text-xs text-gray-700 min-h-[32px]">
            <input type="radio" name={`cierre-${v.id}`} checked={motivo === k} onChange={() => setMotivo(k)} />
            {MOTIVO_CIERRE_TEXTO[k]}
          </label>
        ))}
      </div>
      <textarea className={inputCls} rows={2} maxLength={500} placeholder="Nota (opcional): por qué se cierra" value={nota} onChange={(e) => setNota(e.target.value)} />
      <p className="text-[11px] text-gray-500">No se le escribe nada al cliente. Solo se puede cerrar sin cobros registrados; con cobros se resuelve como cancelación.</p>
      <button type="button" disabled={ocupado || !!falta} onClick={() => motivo && onCerrar(motivo, nota.trim())} className={`${btn} border-gray-700 bg-gray-700 text-white`}>Cerrar la solicitud</button>
      {falta && <p className="text-[11px] text-gray-500">{falta}</p>}
    </Caja>
  );
}

const COLS_CLIENTE = "id, nombre, empresa, nombre_comercial, tipo, ruc, dni, telefono, email, ciudad, estado";

function FormVincular({ v, ocupado, onCancelar, onVincular }: {
  v: VistaSolicitud; ocupado: boolean; onCancelar: () => void; onVincular: (c: ClienteBuscable) => void;
}) {
  const [clientes, setClientes] = useState<ClienteBuscable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegido, setElegido] = useState<ClienteBuscable | null>(null);
  useEffect(() => {
    let vivo = true;
    (async () => {
      const todos: ClienteBuscable[] = [];
      for (let desde = 0; ; desde += 1000) {
        const { data, error: e } = await supabase.from("clientes").select(COLS_CLIENTE).order("nombre").order("id").range(desde, desde + 999);
        if (!vivo) return;
        if (e) { setError(e.message); setClientes([]); return; }
        todos.push(...((data ?? []) as ClienteBuscable[]));
        if (!data || data.length < 1000) break;
      }
      setClientes(todos);
    })();
    return () => { vivo = false; };
  }, []);
  const tel = elegido?.telefono?.trim() || null;
  const mismo = tel ? mismoTelefonoE164(tel, v.contacto.waId) : null;
  return (
    <Caja titulo="Vincular cliente del ERP" onCancelar={onCancelar}>
      {v.cliente && <p className="text-xs text-gray-700">Hoy está vinculada a <b>{v.cliente.nombre}</b>. El servidor no reemplaza un cliente ya puesto en la cotización: eso se corrige en /cotizaciones.</p>}
      {error ? (
        <p className="text-xs text-red-700">No se pudieron leer los clientes: {error}</p>
      ) : (
        <SelectorCliente clientes={clientes ?? []} cargando={clientes == null} valor={elegido ? String(elegido.id) : ""} onElegir={setElegido} placeholder="Busca por nombre, RUC, DNI o teléfono…" />
      )}
      {elegido && (tel
        ? mismo
          ? <p className="text-[11px] text-green-700">El teléfono de la ficha ({formatearTelefono(tel) || tel}) es el de este WhatsApp.</p>
          : <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">El teléfono de la ficha ({formatearTelefono(tel) || tel}) no es el de este WhatsApp ({telLegible(v.contacto.waId)}): comprueba que sea la misma persona. Sus datos salen en la Confirmación que se le envía a este número.</p>
        : <p className="text-[11px] text-gray-500">La ficha no tiene teléfono: no se puede comparar con este WhatsApp.</p>)}
      <button type="button" disabled={ocupado || !elegido} onClick={() => elegido && onVincular(elegido)} className={`${btn} border-[#0b315f] bg-[#0b315f] text-white`}>Vincular</button>
      {!elegido && <p className="text-[11px] text-gray-500">Elige un cliente del ERP.</p>}
    </Caja>
  );
}

function FormConfirmacion({ v, ocupado, sinProgramacion, onCancelar, onEnviar }: {
  v: VistaSolicitud; ocupado: boolean; sinProgramacion: boolean; onCancelar: () => void;
  onEnviar: (idioma: "es" | "en", extras: NonNullable<CuerpoTarjeta["extras"]>) => void;
}) {
  const [idioma, setIdioma] = useState<"es" | "en">("es");
  const [vuelo, setVuelo] = useState(v.vuelo ?? "");
  const [encuentro, setEncuentro] = useState("");
  const [nota, setNota] = useState("");
  const [telCond, setTelCond] = useState(false);
  const falta = sinProgramacion ? "Exige además el módulo Programación." : null;
  return (
    <Caja titulo="Emitir y enviar la Confirmación de Reserva" onCancelar={onCancelar}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-gray-700">Idioma del PDF
          <select className={`${inputCls} mt-1`} value={idioma} onChange={(e) => setIdioma(e.target.value === "en" ? "en" : "es")}>
            <option value="es">Español</option><option value="en">Inglés</option>
          </select>
        </label>
        <label className="text-xs text-gray-700">Vuelo (opcional)
          <input className={`${inputCls} mt-1`} maxLength={40} value={vuelo} onChange={(e) => setVuelo(e.target.value)} placeholder="Ej.: LA2045" />
        </label>
        <label className="text-xs text-gray-700">Punto de encuentro (opcional)
          <input className={`${inputCls} mt-1`} maxLength={200} value={encuentro} onChange={(e) => setEncuentro(e.target.value)} />
        </label>
        <label className="text-xs text-gray-700">Nota para el cliente (opcional)
          <input className={`${inputCls} mt-1`} maxLength={300} value={nota} onChange={(e) => setNota(e.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-700 min-h-[32px]">
        <input type="checkbox" checked={telCond} onChange={(e) => setTelCond(e.target.checked)} />
        Incluir el teléfono del conductor (solo si ya está asignado)
      </label>
      <p className="text-[11px] text-gray-500">Si a la reserva le falta algo (precio, asignación, adelanto…), no se emite y se dice qué.{v.ventana.abierta ? "" : " Fuera de la ventana de 24 h se emite y te damos el PDF para enviarlo por wa.me."}</p>
      <button type="button" disabled={ocupado || !!falta} className={`${btn} border-[#0b315f] bg-[#0b315f] text-white`}
        onClick={() => onEnviar(idioma, { vuelo: vuelo.trim() || null, punto_encuentro: encuentro.trim() || null, nota: nota.trim() || null, incluir_telefono_conductor: telCond })}>
        {v.ventana.abierta ? "Emitir y enviar por WhatsApp" : "Emitir (para enviar por wa.me)"}
      </button>
      {falta && <p className="text-[11px] text-gray-500">{falta}</p>}
    </Caja>
  );
}
