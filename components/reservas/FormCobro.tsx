"use client";
// components/reservas/FormCobro.tsx — El formulario de un movimiento de dinero ya VISTO en el banco:
// el adelanto de una reserva (cobro) o la devolución al cliente. Se extrajo del bloque «Registrar
// adelanto validado» de components/programacion/ModalConfirmacionReserva.tsx y lo usan ese modal,
// la tarjeta de la reserva de traslado del CRM y la pestaña «Adelantos de reservas» de Tesorería.
//
// NO VALIDA el dinero: los topes (no pasar del total, no devolver más de lo decidido), la fecha y el
// número de operación los vuelve a juzgar el servidor (`validarCobro`, lib/confirmacion-reserva-datos.ts)
// y su motivo se enseña tal cual. Aquí solo se piden los cuatro datos y se pregunta antes de grabar:
//  · el monto NO se precarga (tampoco con lo que leyó la IA en el comprobante): un campo relleno
//    invita a grabar un número que nadie comprobó en el banco;
//  · un campo vacío no es un cero: sin monto, el botón se apaga diciendo qué falta;
//  · la pregunta (`pregunta`) la arma quien lo usa y NOMBRA el dinero.

import { useState, type ReactNode } from "react";
import { fechaLima } from "@/lib/alertas-horario";

export const METODOS_COBRO = ["transferencia", "deposito", "yape", "plin", "tarjeta", "efectivo"] as const;
export type DatosCobro = { monto: number; fecha: string; metodo: string; referencia: string };

const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 min-h-[40px]";
const hoyLima = () => fechaLima(Date.now());

/** «1.234,50», «1234.5» o «1,234.50» → número; null si no es un número mayor que cero. */
export function leerMonto(t: string): number | null {
  let s = t.trim().replace(/\s/g, "").replace(/^(S\/|US\$|\$)/i, "");
  if (!s) return null;
  // Con los dos separadores, el último es el decimal.
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export default function FormCobro({
  titulo, moneda, textoBoton, textoOcupado, ocupado, bloqueado, motivoBloqueo, pregunta, onRegistrar, nota, tono = "cobro",
}: {
  titulo: string;
  moneda: "PEN" | "USD";
  textoBoton: string;
  textoOcupado?: string;
  /** Otra operación en curso: el formulario no se puede enviar. */
  ocupado: boolean;
  /** No se puede registrar (sin migración, sin permiso…): el motivo va debajo. */
  bloqueado?: boolean;
  motivoBloqueo?: string | null;
  /** La pregunta antes de grabar (nombra el dinero). null = no se pregunta. */
  pregunta: (d: DatosCobro) => string | null;
  /** true si quedó grabado (el formulario se limpia). */
  onRegistrar: (d: DatosCobro) => Promise<boolean>;
  nota?: ReactNode;
  tono?: "cobro" | "devolucion";
}) {
  const [f, setF] = useState({ monto: "", fecha: hoyLima(), metodo: "transferencia", referencia: "" });
  const [enviando, setEnviando] = useState(false);
  const monto = leerMonto(f.monto);
  const falta = bloqueado ? (motivoBloqueo || "No se puede registrar ahora.")
    : !f.monto.trim() ? "Escribe el monto."
      : monto == null ? "El monto tiene que ser un número mayor que cero, con hasta dos decimales."
        : !f.fecha ? "Elige la fecha del movimiento."
          : f.metodo !== "efectivo" && !f.referencia.trim() ? "Escribe el número de operación (o elige efectivo)." : null;

  const registrar = async () => {
    if (falta || monto == null || ocupado || enviando) return;
    const d: DatosCobro = { monto, fecha: f.fecha, metodo: f.metodo, referencia: f.referencia.trim() };
    const q = pregunta(d);
    if (q && !window.confirm(q)) return;
    setEnviando(true);
    const ok = await onRegistrar(d);
    setEnviando(false);
    if (ok) setF((x) => ({ ...x, monto: "", referencia: "" }));
  };

  const color = tono === "devolucion" ? "bg-sky-700" : "bg-green-700";
  return (
    <div>
      <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">{titulo} ({moneda === "USD" ? "US$" : "S/"})</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <input className={inputCls} inputMode="decimal" placeholder="Monto" aria-label="Monto" value={f.monto} disabled={bloqueado}
          onChange={(e) => setF({ ...f, monto: e.target.value })} />
        <input className={inputCls} type="date" max={hoyLima()} aria-label="Fecha" value={f.fecha} disabled={bloqueado}
          onChange={(e) => setF({ ...f, fecha: e.target.value })} />
        <select className={inputCls} aria-label="Medio" value={f.metodo} disabled={bloqueado} onChange={(e) => setF({ ...f, metodo: e.target.value })}>
          {METODOS_COBRO.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className={inputCls} aria-label="Número de operación" maxLength={60} placeholder={f.metodo === "efectivo" ? "Nº de recibo (opcional)" : "Nº de operación"} value={f.referencia}
          disabled={bloqueado} onChange={(e) => setF({ ...f, referencia: e.target.value })} />
      </div>
      <button type="button" onClick={registrar} disabled={!!falta || ocupado || enviando}
        className={`mt-2 px-3 py-2 rounded-xl text-xs font-black text-white disabled:opacity-40 min-h-[40px] ${color}`}>
        {enviando ? (textoOcupado ?? "Registrando…") : textoBoton}
      </button>
      {falta && <p className="text-[11px] text-gray-500 mt-1">{falta}</p>}
      {nota && <div className="text-[10px] text-gray-400 mt-1">{nota}</div>}
    </div>
  );
}
