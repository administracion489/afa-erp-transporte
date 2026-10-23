"use client";
// components/reservas/DetalleSolicitud.tsx — Las piezas que pintan una solicitud de reserva de
// traslado (la `VistaSolicitud` que arma el servidor): su estado, lo que le falta y a quién, el
// dinero, los cobros y devoluciones, y los comprobantes que mandó el cliente con lo que leyó la IA.
// Las usan la tarjeta del CRM y la pestaña «Adelantos de reservas» de Tesorería, así las dos dicen
// lo mismo de la misma solicitud.
//
// Todo lo que viene de la base se pinta como TEXTO. Nada aquí decide: lo que falta (`pendientes`),
// el cotejo del comprobante (`TEXTO_COTEJO`) y los motivos del orden los escribe el servidor.

import { useState } from "react";
import type { ComprobanteVista, VistaSolicitud } from "@/lib/traslados/reserva-solicitud-tipos";
import { ESTADO_SOLICITUD, QUIEN_PENDIENTE, dinero, fechaDdMm, fechaHoraLima, horaCorta } from "./reserva-traslado-pantalla";

export function ChipEstado({ estado }: { estado: VistaSolicitud["estado"] }) {
  const e = ESTADO_SOLICITUD[estado] ?? { label: estado, color: "#4b5563", bg: "#f3f4f6" };
  return <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color: e.color, background: e.bg }}>{e.label}</span>;
}

/** Lo que le falta a la solicitud, en orden, con su dueño. Vacío = no le falta nada. */
export function ListaPendientes({ v, ahoraMs }: { v: VistaSolicitud; ahoraMs: number }) {
  if (!v.pendientes.length) return <p className="text-xs text-green-700">No le falta nada.</p>;
  return (
    <ul className="space-y-1">
      {v.pendientes.map((p, i) => {
        const q = QUIEN_PENDIENTE[p.quien] ?? { label: p.quien, color: "#4b5563", bg: "#f3f4f6" };
        const venceMs = p.vence ? Date.parse(p.vence) : NaN;
        const vencido = Number.isFinite(venceMs) && venceMs < ahoraMs;
        return (
          <li key={`${p.codigo}-${i}`} className="flex items-start gap-2 text-xs text-gray-700">
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5" style={{ color: q.color, background: q.bg }}>{q.label}</span>
            <span className="break-words">
              {p.detalle}
              {p.vence && <span className={vencido ? "text-red-700 font-semibold" : "text-gray-500"}> · {vencido ? "venció" : "antes de"} el {fechaHoraLima(p.vence)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Total, adelanto, saldo, cobrado, devuelto y lo que se retiene, cada número con su rótulo. */
export function BloqueDinero({ v }: { v: VistaSolicitud }) {
  const c = v.cotizacion;
  const m = v.dinero.moneda;
  const credito = v.motivos.some((x) => x.codigo === "credito");
  const celdas: { t: string; v: string; cls?: string; title?: string }[] = [
    { t: "Total del servicio", v: dinero(c?.total ?? null, m) },
    {
      t: c?.pct != null ? `Adelanto (${c.pct} %)` : "Adelanto",
      v: credito ? "a crédito" : c?.adelanto != null ? dinero(c.adelanto, m) : "sin calcular",
      title: credito ? "Cliente con condición de crédito: no se le pide adelanto." : c?.adelanto == null ? "Todavía no se le comunicó un porcentaje (se fija al confirmar la unidad con «disponibilidad primero»), o la cotización no tiene importes." : undefined,
    },
    { t: "Saldo al recoger", v: c?.saldo != null ? dinero(c.saldo, m) : "—" },
    { t: "Cobrado (verificado)", v: dinero(v.dinero.cobrado, m), cls: v.dinero.cobrado > 0 ? "text-green-700" : "" },
  ];
  if (v.dinero.devuelto > 0 || v.dinero.aDevolver != null) celdas.push({ t: "Devuelto", v: dinero(v.dinero.devuelto, m) });
  if (v.dinero.aDevolver != null) celdas.push({ t: "A devolver (decidido)", v: dinero(v.dinero.aDevolver, m) });
  if (v.dinero.retenido > 0) celdas.push({ t: "Retenido (cargo)", v: dinero(v.dinero.retenido, m) });
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {celdas.map((x) => (
          <div key={x.t} className="rounded-lg bg-gray-50 border border-gray-100 px-2 py-1.5" title={x.title}>
            <p className="text-[9px] font-bold uppercase tracking-wide text-gray-400">{x.t}</p>
            <p className={`text-sm font-black text-gray-800 ${x.cls ?? ""}`}>{x.v}</p>
          </div>
        ))}
      </div>
      {c?.importesVigentes === false && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
          La cotización N° {c.numero} cambió desde que se le comunicó el adelanto al cliente: el monto que tiene el cliente ya no es el de hoy. Revísala en /cotizaciones antes de confirmar.
        </p>
      )}
      <p className="text-[10px] text-gray-400">«Cobrado» es solo lo que Tesorería registró al ver el dinero en el banco; un comprobante del cliente no suma.</p>
    </div>
  );
}

export function ListaPagos({ v }: { v: VistaSolicitud }) {
  if (!v.pagos.length) return null;
  return (
    <ul className="space-y-1">
      {v.pagos.map((p) => (
        <li key={p.id} className={`flex flex-wrap items-center justify-between gap-2 text-xs rounded-lg px-2 py-1 ${p.anulado ? "bg-gray-50 text-gray-400 line-through" : p.sentido === "pago" ? "bg-sky-50 text-sky-800" : "bg-green-50 text-green-800"}`}>
          <span className="break-words">
            {p.sentido === "pago" ? "↩ Devolución" : "Cobro"} {p.codigo ?? `#${p.id}`} · {fechaDdMm(p.fecha)} · {p.metodo ?? "—"}{p.referencia ? ` · op. ${p.referencia}` : ""}{p.anulado ? " · anulado" : ""}
          </span>
          <span className="font-bold">{dinero(p.monto, p.moneda === "USD" ? "USD" : "PEN")}</span>
        </li>
      ))}
    </ul>
  );
}

function Lectura({ k, moneda }: { k: ComprobanteVista; moneda: "PEN" | "USD" }) {
  const l = k.lectura;
  if (!l) return <p className="text-xs text-amber-800">La IA no pudo leer este comprobante.</p>;
  const montoTxt = l.monto != null ? dinero(l.monto, l.moneda === "USD" ? "USD" : l.moneda === "PEN" ? "PEN" : moneda) : null;
  const partes = [
    montoTxt ? `monto ${montoTxt}${l.textoMonto ? ` («${l.textoMonto}»)` : ""}` : l.textoMonto ? `monto «${l.textoMonto}»` : "monto: no se ve",
    l.moneda ? `moneda ${l.moneda}` : "",
    l.fecha ? `fecha ${fechaDdMm(l.fecha)}${l.hora ? ` ${horaCorta(l.hora)}` : ""}` : "fecha: no se ve",
    l.operacion ? `op. ${l.operacion}` : "n.º de operación: no se ve",
    l.medio ? `medio ${l.medio}` : "",
    l.bancoDestino || l.cuentaDestino ? `destino ${[l.bancoDestino, l.cuentaDestino].filter(Boolean).join(" ")}` : "",
    l.confianza ? `confianza ${l.confianza}` : "",
  ].filter(Boolean);
  return <p className="text-xs text-gray-700 break-words"><span className="text-gray-500">La IA leyó (puede equivocarse):</span> {partes.join(" · ")}</p>;
}

/**
 * Los comprobantes que mandó el cliente, el más nuevo primero. `onVer` (solo en la tarjeta del CRM)
 * abre el ÚLTIMO con un enlace firmado: es el único que la ruta sabe abrir; los anteriores están en
 * el chat.
 */
export function ListaComprobantes({ v, onVer, viendo, sinVer }: {
  v: VistaSolicitud;
  onVer?: () => void;
  viendo?: boolean;
  /** Por qué no se puede abrir el archivo desde aquí (Tesorería). */
  sinVer?: string | null;
}) {
  if (!v.comprobantes.length) return <p className="text-xs text-gray-500">El cliente todavía no mandó ningún comprobante registrado.</p>;
  return (
    <ul className="space-y-2">
      {v.comprobantes.map((k, i) => (
        <li key={k.id} className="rounded-lg border border-gray-200 p-2 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-gray-600">📎 Comprobante del {fechaHoraLima(k.creadoEn)}</span>
            {k.seguro && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-50 text-green-700">cubre el adelanto</span>}
            {k.leidoEn && <span className="text-[10px] text-gray-400">abierto el {fechaHoraLima(k.leidoEn)}</span>}
            {i === 0 && onVer && k.mensajeId && (
              <button type="button" onClick={onVer} disabled={viendo}
                className="ml-auto text-[11px] font-bold px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 min-h-[32px]">
                {viendo ? "Abriendo…" : "👁 Ver"}
              </button>
            )}
          </div>
          <Lectura k={k} moneda={v.dinero.moneda} />
          {!k.seguro && k.cotejo.length > 0 && (
            <ul className="text-[11px] text-amber-800 space-y-0.5">
              {k.cotejo.map((c, j) => <li key={`${c.codigo}-${j}`}>⚠ {c.texto}</li>)}
            </ul>
          )}
          {k.correoError ? (
            <p className="text-[11px] text-amber-800">El correo a Tesorería no salió: {k.correoError}</p>
          ) : k.correoEn ? (
            <p className="text-[10px] text-gray-400">Correo a Tesorería enviado el {fechaHoraLima(k.correoEn)}.</p>
          ) : null}
        </li>
      ))}
      {onVer && v.comprobantes.length > 1 && <li className="text-[10px] text-gray-400">Desde aquí se abre el último; los anteriores están en el chat.</li>}
      {!onVer && sinVer && <li className="text-[10px] text-gray-500">{sinVer}</li>}
    </ul>
  );
}

/** La política que la IA le envía al cliente (la de la plantilla de su cotización), plegada. */
export function PoliticaReserva({ lineas, abiertaInicial = false }: { lineas: readonly string[]; abiertaInicial?: boolean }) {
  const [abierta, setAbierta] = useState(abiertaInicial);
  if (!lineas.length) return <p className="text-[11px] text-amber-800">La cotización no tiene política de reserva, cambios y cancelación: decide con la política publicada de la empresa.</p>;
  return (
    <div>
      <button type="button" onClick={() => setAbierta((x) => !x)} className="text-[11px] font-bold text-[#0b315f] underline min-h-[32px]">
        {abierta ? "▾ Ocultar" : "▸ Ver"} la política de reserva, cambios y cancelación ({lineas.length} {lineas.length === 1 ? "línea" : "líneas"})
      </button>
      {abierta && <ul className="list-disc pl-5 mt-1 space-y-0.5 text-xs text-gray-700 break-words">{lineas.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  );
}

/** Lo que el servidor no pudo leer: la vista sale igual, con menos datos, y se dice. */
export function AvisosVista({ v }: { v: VistaSolicitud }) {
  if (!v.avisos.length) return null;
  return (
    <ul className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 space-y-0.5">
      {v.avisos.map((a, i) => <li key={i} className="break-words">⚠ {a}</li>)}
    </ul>
  );
}
