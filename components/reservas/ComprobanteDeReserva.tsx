"use client";
// components/reservas/ComprobanteDeReserva.tsx — En la Confirmación de Reserva (/programacion): si la
// reserva nació de un pedido por WhatsApp a la IA del CRM, el comprobante que mandó el cliente, para
// que quien registra el adelanto o emite la confirmación lo vea sin ir a buscarlo al chat.
//
// CÓMO SE LLEGA A LA SOLICITUD, Y POR QUÉ ASÍ: la tabla `reserva_solicitudes` no tiene políticas para
// la sesión (solo la lee el servidor), y GET /api/reservas/confirmacion no la devuelve. Se sigue la
// cadena que sí puede leer quien tiene el módulo CRM: reserva → su cotización (con
// `crm_conversacion_id`) → las tarjetas `reserva_traslado` de esa conversación → la vista de la
// tarjeta (GET /api/crm/reservas-traslado), que el servidor arma comprobando conversación ↔ tarjeta
// ↔ solicitud ↔ cotización. Solo se enseña una solicitud cuya cotización ES la de esta reserva.
// Sin el módulo CRM no se puede leer la tarjeta: se dice dónde se ve.
//
// «👁 Ver» abre el último comprobante con un enlace firmado (y lo marca abierto, como en el CRM).

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePuedeVer } from "@/lib/usePuedeVer";
import type { VistaSolicitud } from "@/lib/traslados/reserva-solicitud-tipos";
import { ChipEstado, ListaComprobantes } from "./DetalleSolicitud";
import { accionTarjeta, leerVistaTarjeta, textoFallo } from "./reserva-traslado-pantalla";

const MODULOS = ["crm"] as const;

type Origen =
  | { tipo: "no_es_de_la_ia" }
  | { tipo: "de_la_ia"; cotizacionId: number; numero: string | null; convId: string }
  | { tipo: "error"; detalle: string };

type Hallada = { vista: VistaSolicitud; accionId: string; convId: string };

/** ¿La reserva viene de una cotización del CRM? (reservas y cotizaciones las lee cualquier sesión del ERP). */
async function origenDe(reservaId: number): Promise<Origen> {
  const { data: r, error } = await supabase.from("reservas").select("id, cotizacion_id").eq("id", reservaId).maybeSingle();
  if (error) return { tipo: "error", detalle: error.message };
  const cotId = Number((r as { cotizacion_id?: unknown } | null)?.cotizacion_id);
  if (!Number.isInteger(cotId) || cotId <= 0) return { tipo: "no_es_de_la_ia" };
  const { data: c, error: e2 } = await supabase.from("cotizaciones").select("id, numero_cotizacion, crm_conversacion_id").eq("id", cotId).maybeSingle();
  if (e2) {
    // Sin la columna del CRM en cotizaciones no hay pedidos por WhatsApp que buscar.
    return /crm_conversacion_id/.test(e2.message) ? { tipo: "no_es_de_la_ia" } : { tipo: "error", detalle: e2.message };
  }
  const conv = (c as { crm_conversacion_id?: unknown } | null)?.crm_conversacion_id;
  if (typeof conv !== "string" || !conv) return { tipo: "no_es_de_la_ia" };
  const numero = (c as { numero_cotizacion?: unknown }).numero_cotizacion;
  return { tipo: "de_la_ia", cotizacionId: cotId, numero: typeof numero === "string" && numero ? numero : null, convId: conv };
}

/** La solicitud de esa cotización, por la tarjeta del CRM. null = no hay ninguna (no se pidió reservar). */
async function buscarSolicitud(o: Extract<Origen, { tipo: "de_la_ia" }>): Promise<{ ok: true; hallada: Hallada | null } | { ok: false; detalle: string }> {
  const { data, error } = await supabase.from("crm_acciones_ia").select("id, conversacion_id, payload, resultado_id, creada_at")
    .eq("conversacion_id", o.convId).eq("tipo", "reserva_traslado").limit(20);
  if (error) return { ok: false, detalle: error.message };
  const filas = ((data ?? []) as { id: string; conversacion_id: string; payload: unknown; resultado_id: number | null; creada_at?: string }[])
    .filter((a) => Number((a.payload as { cotizacion_id?: unknown } | null)?.cotizacion_id) === o.cotizacionId)
    .sort((a, b) => String(b.creada_at ?? "").localeCompare(String(a.creada_at ?? "")));
  let ultimoError: string | null = null;
  for (const a of filas.slice(0, 3)) {
    const sid = Number((a.payload as { solicitud_id?: unknown } | null)?.solicitud_id ?? a.resultado_id);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    const r = await leerVistaTarjeta({ solicitudId: sid, conversacionId: a.conversacion_id, accionId: a.id });
    if (!r.ok) { ultimoError = r.detalle; continue; }
    if (r.datos.vista.cotizacion?.id === o.cotizacionId) return { ok: true, hallada: { vista: r.datos.vista, accionId: a.id, convId: a.conversacion_id } };
  }
  return ultimoError ? { ok: false, detalle: ultimoError } : { ok: true, hallada: null };
}

export default function ComprobanteDeReserva({ reservaId }: { reservaId: number }) {
  const puede = usePuedeVer(MODULOS);
  const [origen, setOrigen] = useState<Origen | null>(null);
  const [busqueda, setBusqueda] = useState<{ n: number; r: Awaited<ReturnType<typeof buscarSolicitud>> } | null>(null);
  const [n, setN] = useState(0);
  const [viendo, setViendo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void origenDe(reservaId).then((o) => { if (vivo) setOrigen(o); });
    return () => { vivo = false; };
  }, [reservaId]);

  const puedeCrm = puede ? !!puede.crm : null;
  useEffect(() => {
    if (origen?.tipo !== "de_la_ia" || puedeCrm !== true) return;
    let vivo = true;
    const mio = n;
    void buscarSolicitud(origen).then((r) => { if (vivo) setBusqueda({ n: mio, r }); });
    return () => { vivo = false; };
  }, [origen, puedeCrm, n]);

  if (!origen || origen.tipo === "no_es_de_la_ia") return null;
  if (origen.tipo === "error") return null; // un dato de apoyo: si no se pudo leer, la confirmación sigue igual
  const cot = origen.numero ? `cotización N° ${origen.numero}` : "su cotización";
  if (puedeCrm === false) {
    return (
      <p className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-[11px] text-gray-600">
        Esta reserva viene de un pedido por WhatsApp a la IA del CRM ({cot}). El comprobante que mandó el cliente se ve en la tarjeta de su chat en el CRM (hace falta el módulo CRM) o en Tesorería → Adelantos de reservas.
      </p>
    );
  }
  if (puedeCrm == null || !busqueda || busqueda.n !== n) {
    return <p className="text-[11px] text-gray-400">Buscando el pedido por WhatsApp de esta reserva…</p>;
  }
  if (!busqueda.r.ok) {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">
        Esta reserva viene de un pedido por WhatsApp ({cot}), pero no se pudo leer su solicitud: {busqueda.r.detalle}{" "}
        <button type="button" onClick={() => setN((x) => x + 1)} className="underline font-bold">Reintentar</button>
      </p>
    );
  }
  const h = busqueda.r.hallada;
  if (!h) return null; // la conversación no pidió reservar esta cotización
  const v = h.vista;

  const ver = async () => {
    const w = window.open("", "_blank");
    setViendo(true); setAviso(null);
    const r = await accionTarjeta({ accion: "ver_comprobante", solicitud_id: v.id, conversacion_id: h.convId, accion_id: h.accionId });
    setViendo(false);
    if (r.ok && r.url) {
      if (w) { w.opener = null; w.location.href = r.url; } else window.open(r.url, "_blank", "noopener,noreferrer");
    } else {
      w?.close();
      setAviso(textoFallo(r.codigo, r.detalle));
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-black uppercase text-[#0b315f] flex-1">Pedido por WhatsApp · {cot}</p>
        <ChipEstado estado={v.estado} />
        <a href={`/crm?conv=${encodeURIComponent(h.convId)}`} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-[#0b315f] underline">Abrir el chat ↗</a>
      </div>
      <ListaComprobantes v={v} onVer={v.acciones.includes("ver_comprobante") ? () => void ver() : undefined} viendo={viendo} />
      {aviso && <p className="text-[11px] text-red-700">{aviso}</p>}
      <p className="text-[10px] text-gray-400">El comprobante es evidencia, no un cobro: el adelanto se registra cuando el dinero se ve en la cuenta.</p>
    </section>
  );
}
