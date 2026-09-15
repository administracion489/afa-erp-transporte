"use client";
// La FICHA de un tipo de vehículo: nombre, capacidad, grupo e ícono.
//
// POR QUÉ ES UN MODAL Y NO UNA CELDA EDITABLE MÁS. Las quince celdas de la tabla son números
// sueltos que se guardan en `onBlur`; esto son cuatro campos que se leen juntos y que cambian
// cómo se ve este tipo en el cotizador, en el comparativo de unidades y en el tarifario. Se
// enseña el plan —qué campo cambia, de qué a qué— ANTES del botón, igual que el modal del
// rendimiento medido enseña la evidencia antes de aplicar.
//
// LA CLAVE SE MUESTRA Y NO SE EDITA. Es el puente sin FK con la flota, el historial y lo ya
// cotizado; el porqué está escrito en lib/costos/ficha-tipo.ts. Enseñarla en gris es lo que
// evita la pregunta "¿y por qué no puedo tocar esto?" — y que alguien la cambie por SQL.
import React, { useMemo, useState } from "react";
import {
  planDeFicha, fichaAForm, GRUPOS_VEHICULO, ICONOS_VEHICULO,
  type ActaFicha, type FichaTipo, type FormFicha,
} from "@/lib/costos/ficha-tipo";

export default function ModalFichaTipo({
  ficha, otros, nota, guardando, onGuardar, onCerrar,
}: {
  ficha: FichaTipo;
  /** Los demás tipos activos: solo para avisar de un nombre repetido. */
  otros: { tipo_vehiculo: string; nombre: string }[];
  /** El "motivo del cambio" de la barra de arriba. Se anexa a cada acta. */
  nota: string;
  guardando: boolean;
  onGuardar: (patch: Record<string, unknown>, actas: ActaFicha[], resumen: string) => void;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<FormFicha>(() => fichaAForm(ficha));
  const f = (k: keyof FormFicha) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));

  const plan = useMemo(() => planDeFicha(ficha, form, nota, otros), [ficha, form, nota, otros]);

  // El grupo guardado puede no estar en la lista (filas antiguas): se ofrece igual, o el
  // desplegable lo cambiaría solo al abrir el modal.
  const grupos = useMemo(() => {
    const g = [...GRUPOS_VEHICULO] as string[];
    const actual = (ficha.grupo_vehiculo ?? "").trim();
    if (actual && !g.includes(actual)) g.push(actual);
    return g;
  }, [ficha.grupo_vehiculo]);

  const guardar = () => {
    if (!plan.guardable || guardando) return;
    onGuardar(plan.patch, plan.actas, plan.cambios.map(c => `${c.etiqueta}: ${c.antes} → ${c.despues}`).join(" · "));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onCerrar}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">✏️ Ficha del tipo de vehículo</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Cómo se llama y cómo se lista. Ninguno de estos campos entra en el costo por kilómetro.
            </p>
          </div>
          <button onClick={onCerrar} className="text-gray-400 hover:text-gray-600 font-bold text-xl leading-none">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* LA CLAVE — visible, en gris, con el motivo escrito. */}
          <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">Clave del tipo (no se edita)</p>
            <p className="font-mono font-black text-gray-700 text-sm">{ficha.tipo_vehiculo}</p>
            <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
              Es con lo que las placas de la flota, el historial de costos y las cotizaciones ya emitidas
              apuntan a este tipo. Cambiarla los dejaría apuntando a una clave que no existe: para
              renombrarla hay que dar de alta el tipo nuevo y reasignar las unidades.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Nombre *</label>
              <input
                autoFocus
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]"
                value={form.nombre} onChange={f("nombre")} placeholder="SUV 6 pax GLP"
              />
              <p className="text-[9px] text-gray-300 mt-0.5">Es el texto que se ve en el cotizador, el comparativo y el tarifario.</p>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Capacidad (pax) *</label>
              <input
                type="number" min="1" step="1"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0b315f]"
                value={form.capacidad} onChange={f("capacidad")} placeholder="6"
              />
              <p className="text-[9px] text-gray-300 mt-0.5">Asientos de la categoría, no los de una placa.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Grupo</label>
              <select
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]"
                value={form.grupo_vehiculo} onChange={f("grupo_vehiculo")}
              >
                {grupos.map(g => <option key={g}>{g}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Ícono</label>
              <div className="flex gap-1.5 flex-wrap items-center">
                {ICONOS_VEHICULO.map(ic => (
                  <button key={ic} onClick={() => setForm(p => ({ ...p, icono: ic }))}
                    className={`text-xl p-1.5 rounded-lg border-2 transition-colors ${form.icono === ic ? "border-[#0b315f] bg-[#eef3f8]" : "border-gray-200 hover:border-gray-300"}`}>
                    {ic}
                  </button>
                ))}
                {form.icono && (
                  <button onClick={() => setForm(p => ({ ...p, icono: "" }))}
                    className="text-[10px] font-bold text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg px-2 py-1.5">
                    quitar
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* EL PLAN, antes del botón. */}
          {plan.errores.map((e, i) => (
            <div key={`e${i}`} className="rounded-xl bg-red-50 border border-red-200 px-4 py-2.5 text-xs text-red-700 font-bold">⚠️ {e}</div>
          ))}
          {plan.avisos.map((a, i) => (
            <div key={`a${i}`} className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-xs text-amber-800">{a}</div>
          ))}

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
              <p className="text-[10px] font-black text-gray-500 uppercase tracking-wider">Qué se va a guardar</p>
            </div>
            {plan.cambios.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-400">Nada todavía: la ficha está igual que como está guardada.</p>
            ) : (
              <ul className="divide-y divide-gray-50">
                {plan.cambios.map(c => (
                  <li key={c.campo} className="px-4 py-2 flex items-center gap-2 text-xs">
                    <span className="font-black text-gray-500 w-24 flex-shrink-0">{c.etiqueta}</span>
                    <span className="text-gray-400 line-through truncate">{c.antes}</span>
                    <span className="text-gray-300">→</span>
                    <span className="font-bold text-[#0b315f] truncate">{c.despues}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-[10px] text-gray-400">
            Cada campo cambiado deja su propia fila en el historial, con el motivo de la barra de arriba si lo escribiste.
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-3">
          <button onClick={guardar} disabled={!plan.guardable || guardando}
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40" style={{ background: "#0b315f" }}>
            {guardando ? "Guardando..." : "✓ Guardar ficha"}
          </button>
          <button onClick={onCerrar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
        </div>
      </div>
    </div>
  );
}
