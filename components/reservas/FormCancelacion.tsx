"use client";
// components/reservas/FormCancelacion.tsx — «Resolver la cancelación»: el % de lo cobrado que se le
// devuelve al cliente que pidió cancelar. Lo DECIDE TESORERÍA (módulo Finanzas o Cuentas por Pagar):
// lo usan la tarjeta de la reserva del CRM (solo con ese módulo) y Tesorería → Adelantos de reservas.
// Se extrajo de components/crm/TarjetaReservaTraslado.tsx sin cambiar lo que pinta.
//
// No decide nada: el servidor vuelve a juzgar el porcentaje, que la reserva no siga viva en
// Programación y que no haya un pago reportado sin registrar. Aquí se enseña con qué se decide (la
// anticipación, lo cobrado verificado, la política tal como la recibió el cliente) y cuánto sale.

import { useState, type ReactNode } from "react";
import type { VistaSolicitud } from "@/lib/traslados/reserva-solicitud-tipos";
import { PoliticaReserva } from "@/components/reservas/DetalleSolicitud";
import { cargoRetenido, devolucionDecidida, dinero, fechaHoraLima } from "@/components/reservas/reserva-traslado-pantalla";

const btn = "text-xs px-2.5 py-1.5 rounded-lg border font-semibold disabled:opacity-40 min-h-[36px]";
const inputCls = "w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 min-h-[40px]";

/** Un porcentaje escrito («50», «12,5») → número entre 0 y 100; null si no lo es. */
export function leerPct(t: string): number | null {
  const s = t.trim().replace("%", "").replace(",", ".").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

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

export default function FormCancelacion({ v, reservaViva, ocupado, onCancelar, onResolver }: {
  v: VistaSolicitud; reservaViva: VistaSolicitud["reserva"]; ocupado: boolean; onCancelar: () => void; onResolver: (pct: number) => void;
}) {
  const [txt, setTxt] = useState("");
  const pct = leerPct(txt);
  const m = v.dinero.moneda;
  const cobrado = v.dinero.cobrado;
  const falta = !txt.trim() ? "Escribe el % de lo cobrado que se le devuelve (de 0 a 100), según la política."
    : pct == null ? "El % tiene que ser un número de 0 a 100." : null;
  const monto = pct != null ? devolucionDecidida(cobrado, pct) : null;
  const retenido = monto != null ? cargoRetenido({ cobrado, devuelto: monto }) : null;
  return (
    <Caja titulo="Resolver la cancelación" onCancelar={onCancelar}>
      <p className="text-xs text-gray-700">
        {v.cancelacion
          ? <>Pedida el {fechaHoraLima(v.cancelacion.pedidaEn)} · {v.cancelacion.horasAntes != null ? <b>{v.cancelacion.horasAntes} h de anticipación</b> : "sin hora de servicio para contar la anticipación"}.</>
          : "El cliente pidió cancelar."}
        {" "}Cobrado (verificado): <b>{dinero(cobrado, m)}</b>.
      </p>
      <PoliticaReserva lineas={v.politica} abiertaInicial />
      {reservaViva && (
        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
          La reserva #{reservaViva.id} sigue «{reservaViva.estado}» en Programación: primero cancélala ahí (allí se decide qué pasa con su importe).{" "}
          <a href={`/programacion?editar=${reservaViva.id}`} target="_blank" rel="noopener noreferrer" className="underline font-semibold">Abrir en Programación ↗</a>
        </p>
      )}
      <label className="block text-xs text-gray-700">
        % de lo cobrado que se devuelve
        <input className={`${inputCls} mt-1 max-w-[140px]`} inputMode="decimal" placeholder="0 a 100" value={txt} onChange={(e) => setTxt(e.target.value)} />
      </label>
      {pct != null && (
        <p className="text-xs text-gray-700">
          {cobrado > 0
            ? <>Se devuelven <b>{dinero(monto, m)}</b> de {dinero(cobrado, m)}{retenido != null && retenido > 0 ? <> y se retienen <b>{dinero(retenido, m)}</b> (se crea su comprobante sin número para Facturación; si después entra o se anula un cobro, el ERP lo recalcula mientras no tenga número)</> : ""}.{v.devolucionPlazoH ? ` Plazo para devolver: ${v.devolucionPlazoH} h.` : ""}</>
            : "No hay cobros registrados: no se devuelve nada."}
        </p>
      )}
      <p className="text-[11px] text-gray-500">Se le escribe al cliente por su WhatsApp con lo que se decidió.</p>
      <button type="button" disabled={ocupado || !!falta} onClick={() => pct != null && onResolver(pct)} className={`${btn} border-[#0b315f] bg-[#0b315f] text-white`}>Resolver cancelación</button>
      {falta && <p className="text-[11px] text-gray-500">{falta}</p>}
    </Caja>
  );
}
