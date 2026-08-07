"use client";
// Alta y edición de una SEDE / centro de distribución del cliente.
//
// Sin esto la conformidad no tiene a quién escribirle: el correo y el WhatsApp de
// aprobación salen de aquí, igual que el "Área solicitante / Usuario / Cargo" que va
// impreso en la sección 1 del formato. Hoy AFA lleva un Excel por CD (Callao,
// Trujillo, Huachipa, Piura) y esos datos se re-tipean cada periodo.

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export type Sede = {
  id?: number;
  cliente_id: number | null;
  nombre: string;
  area_solicitante: string | null;
  servicio_contratado: string | null;
  ubicacion_servicio: string | null;
  usuario_solicita: string | null;
  cargo_solicita: string | null;
  email_conformidad: string | null;
  whatsapp_conformidad: string | null;
  email_copia: string | null;
  orden_compra: string | null;
  moneda: string;
  patrones: string[];
  activo: boolean;
};

export const SEDE_VACIA = (clienteId: number | null): Sede => ({
  cliente_id: clienteId,
  nombre: "",
  area_solicitante: "",
  servicio_contratado: "SERVICIO DE TRANSPORTE DE PERSONAL",
  ubicacion_servicio: "",
  usuario_solicita: "",
  cargo_solicita: "",
  email_conformidad: "",
  whatsapp_conformidad: "",
  email_copia: "",
  orden_compra: "",
  moneda: "PEN",
  patrones: [],
  activo: true,
});

const campo = "w-full px-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-[#2a5298]/30";
const label = "text-[11px] font-bold text-gray-500 uppercase tracking-wide";

export default function ModalSede({
  sede, clienteNombre, onCerrar, onGuardada,
}: {
  sede: Sede;
  clienteNombre: string;
  onCerrar: () => void;
  onGuardada: () => void;
}) {
  const [f, setF] = useState<Sede>({ ...sede });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const set = (k: keyof Sede, v: any) => setF((s) => ({ ...s, [k]: v }));

  async function guardar() {
    if (!f.nombre.trim()) { setError("Ponle un nombre a la sede (ej. PEPSICO CD CALLAO)."); return; }
    setGuardando(true); setError("");
    try {
      const fila = {
        cliente_id: f.cliente_id,
        nombre: f.nombre.trim().toUpperCase(),
        area_solicitante: f.area_solicitante?.trim() || f.nombre.trim().toUpperCase(),
        servicio_contratado: f.servicio_contratado?.trim() || null,
        ubicacion_servicio: f.ubicacion_servicio?.trim() || f.nombre.trim().toUpperCase(),
        usuario_solicita: f.usuario_solicita?.trim() || null,
        cargo_solicita: f.cargo_solicita?.trim() || null,
        email_conformidad: f.email_conformidad?.trim() || null,
        whatsapp_conformidad: f.whatsapp_conformidad?.trim() || null,
        email_copia: f.email_copia?.trim() || null,
        orden_compra: f.orden_compra?.trim() || null,
        moneda: f.moneda || "PEN",
        // Los patrones alimentan la asignación automática de servicios a esta sede.
        patrones: (f.patrones || []).map((p) => p.trim().toUpperCase()).filter(Boolean),
        activo: f.activo,
      };
      const { error: e } = f.id
        ? await supabase.from("cliente_sedes").update(fila).eq("id", f.id)
        : await supabase.from("cliente_sedes").insert(fila);
      if (e) throw new Error(e.message);
      onGuardada();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b sticky top-0 bg-white rounded-t-2xl">
          <h3 className="font-black text-[#0b315f]">{f.id ? "Editar sede" : "Nueva sede"}</h3>
          <p className="text-xs text-gray-500">{clienteNombre} · los datos van impresos en el formato y definen a quién se le pide la conformidad.</p>
        </div>

        <div className="p-5 grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Nombre de la sede / CD</label>
              <input className={campo} value={f.nombre} onChange={(e) => set("nombre", e.target.value)} placeholder="PEPSICO CD CALLAO" />
            </div>
            <div>
              <label className={label}>Área solicitante</label>
              <input className={campo} value={f.area_solicitante ?? ""} onChange={(e) => set("area_solicitante", e.target.value)} placeholder="igual al nombre si lo dejas vacío" />
            </div>
          </div>

          <div>
            <label className={label}>Servicio contratado</label>
            <input className={campo} value={f.servicio_contratado ?? ""} onChange={(e) => set("servicio_contratado", e.target.value)} placeholder="SERVICIO DE TRANSPORTE DE PERSONAL / TURNO NOCHE" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Ubicación del servicio</label>
              <input className={campo} value={f.ubicacion_servicio ?? ""} onChange={(e) => set("ubicacion_servicio", e.target.value)} />
            </div>
            <div>
              <label className={label}>Orden de compra / servicio</label>
              <input className={campo} value={f.orden_compra ?? ""} onChange={(e) => set("orden_compra", e.target.value)} placeholder="OC 4500218837" />
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="text-xs font-black text-[#0b315f] uppercase tracking-wide mb-3">Quién aprueba la liquidación</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Usuario que solicita</label>
                <input className={campo} value={f.usuario_solicita ?? ""} onChange={(e) => set("usuario_solicita", e.target.value)} placeholder="MIGUEL CASTRO PORTELLA" />
              </div>
              <div>
                <label className={label}>Cargo</label>
                <input className={campo} value={f.cargo_solicita ?? ""} onChange={(e) => set("cargo_solicita", e.target.value)} placeholder="SUPERVISOR DE RECURSOS HUMANOS" />
              </div>
              <div>
                <label className={label}>Correo para la conformidad</label>
                <input className={campo} value={f.email_conformidad ?? ""} onChange={(e) => set("email_conformidad", e.target.value)} placeholder="contacto@cliente.com" />
              </div>
              <div>
                <label className={label}>WhatsApp para la conformidad</label>
                <input className={campo} value={f.whatsapp_conformidad ?? ""} onChange={(e) => set("whatsapp_conformidad", e.target.value)} placeholder="987 654 321" />
              </div>
              <div className="col-span-2">
                <label className={label}>Copia a (opcional)</label>
                <input className={campo} value={f.email_copia ?? ""} onChange={(e) => set("email_copia", e.target.value)} placeholder="facturacion@cliente.com" />
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <label className={label}>Palabras para reconocer los servicios de esta sede</label>
            <input
              className={campo}
              value={(f.patrones || []).join(", ")}
              onChange={(e) => set("patrones", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))}
              placeholder="CALLAO, CD CALLAO, MIXING CENTER"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Si el nombre de ruta, el origen o el destino de un servicio contiene alguna de estas palabras, se asigna solo a esta sede.
              Separa con comas. Si el cliente tiene una sola sede no hace falta.
            </p>
          </div>

          {error && <div className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end sticky bottom-0 bg-white rounded-b-2xl">
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cancelar</button>
          <button onClick={guardar} disabled={guardando}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-[#0b315f] text-white hover:bg-[#092647] disabled:opacity-50">
            {guardando ? "Guardando…" : "Guardar sede"}
          </button>
        </div>
      </div>
    </div>
  );
}
