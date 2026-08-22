"use client";

// Entregar dinero = abrir una rendición. La regla central del módulo se aplica ANTES
// de dejar escribir nada: al elegir el fondo se consulta el veredicto a Postgres
// (fn_caja_chica_puede_asignar) y, si dice que no, el botón queda muerto. No se
// entrega plata a quien no ha rendido.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { abrirRendicion, hoyLima, puedeAsignar, type VeredictoAsignacion } from "@/lib/finanzas/caja-chica";

type FondoOpcion = {
  fondo_id: number;
  nombre: string;
  responsable_nombre: string;
  moneda: string;
  tope: number | null;
  activo: boolean;
  saldo_en_calle: number | null;
  rendiciones_vivas: number | null;
};

type VehiculoOpcion = { id: number; placa: string };

type Props = {
  onCerrar: () => void;
  /** Se llama tras crear la rendición; el padre cierra, refresca y avisa. */
  onListo: (mensaje: string) => void;
};

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

export default function ModalEntrega({ onCerrar, onListo }: Props) {
  const [fondos, setFondos] = useState<FondoOpcion[]>([]);
  const [vehiculos, setVehiculos] = useState<VehiculoOpcion[]>([]);
  const [usuarioNombre, setUsuarioNombre] = useState<string>("");

  const [fondoId, setFondoId] = useState<string>("");
  const [veredicto, setVeredicto] = useState<VeredictoAsignacion | null>(null);
  const [verificando, setVerificando] = useState(false);

  const [monto, setMonto] = useState<string>("");
  const [fecha, setFecha] = useState<string>(hoyLima());
  const [vehiculoId, setVehiculoId] = useState<string>("");
  const [periodoHasta, setPeriodoHasta] = useState<string>("");
  const [observaciones, setObservaciones] = useState<string>("");
  const [registrarPago, setRegistrarPago] = useState(false);

  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    (async () => {
      const [saldos, vs, ses] = await Promise.all([
        supabase.from("v_caja_chica_saldos").select("*").eq("activo", true).order("responsable_nombre"),
        supabase.from("vehiculos").select("id, placa").order("placa"),
        supabase.auth.getSession(),
      ]);
      setFondos((saldos.data ?? []) as FondoOpcion[]);
      setVehiculos((vs.data ?? []) as VehiculoOpcion[]);

      const uid = ses?.data?.session?.user?.id;
      if (uid) {
        const { data } = await supabase.from("usuarios").select("nombre").eq("id", uid).maybeSingle();
        setUsuarioNombre(String(data?.nombre ?? ""));
      }
    })();
  }, []);

  const evaluarFondo = useCallback(async (id: string) => {
    setFondoId(id);
    setVeredicto(null);
    setError("");
    if (!id) return;
    setVerificando(true);
    const v = await puedeAsignar(supabase, Number(id));
    setVeredicto(v);
    setVerificando(false);
  }, []);

  const fondo = fondos.find((f) => String(f.fondo_id) === fondoId) ?? null;
  const bloqueado = !fondoId || verificando || !veredicto?.puede;

  async function entregar() {
    setError("");
    const importe = Number(monto);
    if (!(importe > 0)) {
      setError("El monto a entregar debe ser mayor a 0.");
      return;
    }
    setGuardando(true);
    const r = await abrirRendicion(supabase, {
      fondo_id: Number(fondoId),
      monto_asignado: importe,
      fecha_entrega: fecha || hoyLima(),
      periodo_desde: fecha || hoyLima(),
      periodo_hasta: periodoHasta || null,
      vehiculo_id: vehiculoId ? Number(vehiculoId) : null,
      registrar_pago: registrarPago,
      observaciones: observaciones.trim() || null,
      creado_por: usuarioNombre || null,
    });
    setGuardando(false);

    if (!r.ok) {
      setError(r.error);
      return;
    }
    onListo(`Entrega registrada · ${r.data.codigo ?? "rendición abierta"}`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCerrar}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <h3 className="font-bold text-gray-900">Entregar dinero</h3>
          <p className="text-xs text-gray-400 mt-1">
            Se abre una rendición a nombre del responsable. Solo se puede entregar si no tiene rendiciones vivas ni vencidas.
          </p>
        </div>

        <div className="p-6 space-y-4">
          <Campo label="Fondo / responsable">
            <select className={inputCls()} value={fondoId} onChange={(e) => evaluarFondo(e.target.value)}>
              <option value="">Selecciona un fondo…</option>
              {fondos.map((f) => (
                <option key={f.fondo_id} value={f.fondo_id}>
                  {f.responsable_nombre} — {f.nombre}
                </option>
              ))}
            </select>
          </Campo>

          {verificando && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 flex items-center gap-3 text-sm text-gray-500">
              <div className="w-4 h-4 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
              Verificando si el responsable puede recibir fondos…
            </div>
          )}

          {!verificando && veredicto && (
            <div
              className={
                veredicto.puede
                  ? "rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-3 text-sm text-emerald-800"
                  : "rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800"
              }
            >
              <span className="text-lg leading-none">{veredicto.puede ? "✅" : "⛔"}</span>
              <div>
                <p className="font-bold">{veredicto.puede ? "Habilitado" : "Bloqueado"}</p>
                <p className="mt-0.5">{veredicto.motivo}</p>
                <p className="text-xs mt-1 opacity-80">
                  En la calle {fmtMoneda(veredicto.saldo_en_calle, fondo?.moneda ?? "PEN")} · {veredicto.rendiciones_vivas} viva
                  {veredicto.rendiciones_vivas === 1 ? "" : "s"} · {veredicto.rendiciones_atrasadas} atrasada
                  {veredicto.rendiciones_atrasadas === 1 ? "" : "s"}
                  {veredicto.tope > 0 ? ` · Tope ${fmtMoneda(veredicto.tope, fondo?.moneda ?? "PEN")}` : ""}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Campo label="Monto a entregar">
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputCls()}
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                placeholder="0.00"
                disabled={bloqueado}
              />
            </Campo>
            <Campo label="Fecha de entrega">
              <input type="date" className={inputCls()} value={fecha} onChange={(e) => setFecha(e.target.value)} disabled={bloqueado} />
            </Campo>
            <Campo label="Vehículo (opcional)">
              <select className={inputCls()} value={vehiculoId} onChange={(e) => setVehiculoId(e.target.value)} disabled={bloqueado}>
                <option value="">Sin vehículo</option>
                {vehiculos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.placa}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Periodo hasta (opcional)">
              <input
                type="date"
                className={inputCls()}
                value={periodoHasta}
                onChange={(e) => setPeriodoHasta(e.target.value)}
                disabled={bloqueado}
              />
            </Campo>
            <Campo label="Observaciones" span={2}>
              <textarea
                rows={2}
                className={inputCls()}
                value={observaciones}
                onChange={(e) => setObservaciones(e.target.value)}
                placeholder="Motivo de la entrega, ruta prevista…"
                disabled={bloqueado}
              />
            </Campo>
          </div>

          <label className="flex items-start gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={registrarPago}
              onChange={(e) => setRegistrarPago(e.target.checked)}
              disabled={bloqueado}
            />
            <span>
              <span className="font-bold">Registrar salida de tesorería</span>
              <span className="block text-xs text-gray-400">
                Emite el pago en efectivo contra la cuenta del fondo, para que el dinero salga del saldo de caja.
              </span>
            </span>
          </label>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
              <span className="text-lg leading-none">⚠️</span>
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button onClick={onCerrar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={entregar}
            disabled={bloqueado || guardando}
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
            style={{ background: "#0b315f" }}
          >
            {guardando ? "Registrando…" : "Entregar"}
          </button>
        </div>
      </div>
    </div>
  );
}
