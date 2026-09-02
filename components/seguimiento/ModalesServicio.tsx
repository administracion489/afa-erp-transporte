"use client";

// ══════════════════════════════════════════════════════════════════════════════
// MODALES DE SERVICIO — Gastos, Reemplazo y Checklist de salida
//
// Traslado literal desde app/seguimiento/page.tsx: mismas consultas, mismas
// tablas (`gastos`, `reservas`, `checklist_salida`), mismos textos y las mismas
// validaciones. No se cambió comportamiento: solo se sacaron de la página para
// poder podar el drawer.
//
// El objeto `Ic` de page.tsx no está exportado, así que aquí se redibujan los
// cuatro íconos que estos modales usan (mismo trazo Feather de 24×24), igual que
// hizo components/seguimiento/FichaServicio.tsx con su propio objeto.
// ══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ── Íconos propios ────────────────────────────────────────────────────────────
type IP = { size?: number; strokeWidth?: number; className?: string; color?: string };
const I = {
  Check: (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="20 6 9 17 4 12"/></svg>,
  Alert: (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  X: (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Plus: (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
};

// ── Constantes compartidas ────────────────────────────────────────────────────
// Se exportan para que page.tsx las importe de aquí en vez de duplicarlas.

export const CHECKLIST_ITEMS = [
  { id: "lavado",      label: "Bus lavado y presentable" },
  { id: "combustible", label: "Combustible completo (tanque lleno)" },
  { id: "viaticos",    label: "Conductor recibió viáticos en efectivo" },
  { id: "documentos",  label: "Contrato, Permiso Turismo y Guía de Remisión a bordo" },
  { id: "botiquin",    label: "Botiquín de emergencias verificado" },
  { id: "conductor",   label: "Conductor con brevete vigente y descanso suficiente" },
  { id: "pasajeros",   label: "Lista de pasajeros confirmada con el responsable" },
  { id: "ruta",        label: "Itinerario impreso entregado al conductor" },
];

export const CATS_GASTO = [
  { valor: "peajes",              label: "🛣️ Peaje"       },
  { valor: "viaticos",            label: "🍽️ Viático"     },
  { valor: "estacionamiento",     label: "🅿️ Estac."      },
  { valor: "multa",               label: "🚨 Multa"       },
  { valor: "conductor_servicio",  label: "🧑‍✈️ Conductor"  },
  { valor: "otro",                label: "💸 Otro"        },
];

type ChecklistRow = { id: number; reserva_id: number; item_id: string; completado: boolean };

// ══════════════════════════════════════════════════════════════════════════════
// MODAL GASTOS
// ══════════════════════════════════════════════════════════════════════════════

export function ModalGastos({ reservaId, vehiculoId, cliente, onClose, onSaved }: {
  reservaId: number; vehiculoId: number|null; cliente: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [gastos,        setGastos]        = useState<{id:number;descripcion:string;monto:number;categoria:string}[]>([]);
  const [nuevoConcepto, setNuevoConcepto] = useState("");
  const [nuevoMonto,    setNuevoMonto]    = useState("");
  const [nuevoCategoria,setNuevoCategoria]= useState("peajes");
  const [cargando,      setCargando]      = useState(true);
  const [guardando,     setGuardando]     = useState(false);
  // Lo que se PRESUPUESTÓ para este servicio y todavía no se cargó como gasto real.
  // No son filas de `gastos`: sembrar el presupuesto en esa tabla lo contaría como
  // egreso real en v_egresos y en el costo del servicio, que es justo lo contrario
  // de lo que se quiere. Aquí solo se muestran para que el operador CONFIRME.
  const [previstos,     setPrevistos]     = useState<{concepto:string;monto:number;base:string}[]>([]);

  const cargar = useCallback(async () => {
    setCargando(true);
    const [{ data }, prev] = await Promise.all([
      supabase.from("gastos").select("id,descripcion,monto,categoria").eq("reserva_id", reservaId).order("created_at"),
      // La tabla es de supabase/costeo-01: si esa migración no se corrió, no hay
      // presupuesto que mostrar y el modal funciona igual que antes.
      (async () => {
        const { data: cab } = await supabase
          .from("v_servicio_costo_estimado").select("id").eq("reserva_id", reservaId).maybeSingle();
        if (!cab?.id) return [];
        const { data: ls } = await supabase
          .from("servicio_costo_estimado_linea")
          .select("concepto,monto,base")
          .eq("estimado_id", cab.id).order("orden");
        return (ls ?? []) as { concepto: string; monto: number; base: string | null }[];
      })().catch(() => []),
    ]);
    setGastos(data || []);
    // Solo los conceptos que SÍ pueden tener comprobante y que aún no lo tienen.
    // El conductor y el desgaste se amortizan: no hay nada que confirmar en campo.
    const yaCargados = new Set((data || []).map((g: { categoria: string }) => String(g.categoria)));
    const CONFIRMABLES = new Set(["peajes", "viaticos", "estacionamiento", "pernocte", "otro"]);
    setPrevistos(
      prev
        .filter((l) => CONFIRMABLES.has(String(l.concepto)) && !yaCargados.has(String(l.concepto)) && Number(l.monto) > 0)
        .map((l) => ({ concepto: String(l.concepto), monto: Number(l.monto), base: String(l.base ?? "") }))
    );
    setCargando(false);
  }, [reservaId]);

  useEffect(() => { cargar(); }, [cargar]);

  const total = gastos.reduce((s, g) => s + Number(g.monto), 0);

  const agregar = async () => {
    if (!nuevoConcepto || !nuevoMonto) return;
    setGuardando(true);
    const { error } = await supabase.from("gastos").insert({
      reserva_id: reservaId, vehiculo_id: vehiculoId,
      fecha: new Date().toISOString().split("T")[0], categoria: nuevoCategoria,
      tipo_gasto: "operativo", descripcion: nuevoConcepto.trim(),
      monto: parseFloat(nuevoMonto), metodo_pago: "efectivo", estado: "pagado",
    });
    if (error) { alert("Error: " + error.message); setGuardando(false); return; }
    setNuevoConcepto(""); setNuevoMonto("");
    await cargar(); setGuardando(false);
  };

  const eliminar = async (id: number) => {
    await supabase.from("gastos").delete().eq("id", id); await cargar();
  };

  const cerrar = () => { onSaved(); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Control de Gastos</h3>
            <p className="text-xs text-gray-400 mt-0.5">Reserva #{reservaId} · {cliente}</p>
          </div>
          <button onClick={cerrar} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors"><I.X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {cargando ? <p className="text-center text-gray-400 text-sm py-4">Cargando...</p>
              : gastos.length === 0 ? <p className="text-center text-gray-400 text-sm py-4">Sin gastos registrados</p>
              : gastos.map(g => (
                <div key={g.id} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-2.5 group">
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <span className="text-sm">{CATS_GASTO.find(c => c.valor === g.categoria)?.label.split(" ")[0] || "💸"}</span>
                    <span className="text-[13px] font-semibold text-gray-700 truncate">{g.descripcion}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-[#0b315f] text-[13px]">S/ {Number(g.monto).toFixed(2)}</span>
                    <button onClick={() => eliminar(g.id)} className="opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><I.X size={12} /></button>
                  </div>
                </div>
              ))}
          </div>
          {/* Lo previsto al costear el servicio, esperando confirmación. Se toca y
              rellena el formulario de abajo: el operador corrige un número en vez de
              escribir el concepto y el importe desde cero. */}
          {previstos.length > 0 && (
            <div className="border rounded-xl p-3 space-y-2" style={{ borderColor: "#fde68a", background: "#fffbeb" }}>
              <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "#b45309" }}>
                Previsto al costear · falta confirmar
              </p>
              {previstos.map(p => (
                <button
                  key={p.concepto}
                  type="button"
                  onClick={() => {
                    setNuevoCategoria(p.concepto === "pernocte" ? "otro" : p.concepto);
                    setNuevoConcepto(CATS_GASTO.find(c => c.valor === p.concepto)?.label.replace(/^\S+\s/, "") || p.concepto);
                    setNuevoMonto(String(p.monto));
                  }}
                  className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-amber-100/60 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold" style={{ color: "#92400e" }}>
                      {CATS_GASTO.find(c => c.valor === p.concepto)?.label || p.concepto}
                    </span>
                    {p.base && <span className="block text-[10px] truncate" style={{ color: "#b45309" }}>{p.base}</span>}
                  </span>
                  <span className="font-black text-[13px] shrink-0 ml-2" style={{ color: "#b45309" }}>
                    S/ {p.monto.toFixed(2)} →
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between bg-[#0b315f] rounded-xl px-4 py-3">
            <span className="text-white/70 text-sm font-semibold">Total gastado</span>
            <span className="text-white font-black text-lg">S/ {total.toFixed(2)}</span>
          </div>
          <div className="border border-gray-100 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Agregar gasto</p>
            <div className="grid grid-cols-3 gap-1">
              {CATS_GASTO.map(c => (
                <button key={c.valor} onClick={() => setNuevoCategoria(c.valor)}
                  className={`text-[10px] font-bold px-2 py-1.5 rounded-lg transition-colors text-left ${nuevoCategoria === c.valor ? "bg-[#0b315f] text-white" : "bg-gray-50 text-gray-600 hover:bg-gray-100"}`}>
                  {c.label}
                </button>
              ))}
            </div>
            <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors"
              placeholder="Descripción (ej: Peaje Canta, Viático conductor)" value={nuevoConcepto} onChange={e => setNuevoConcepto(e.target.value)} />
            <div className="flex gap-2">
              <input type="number" step="0.01" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors"
                placeholder="Monto S/" value={nuevoMonto} onChange={e => setNuevoMonto(e.target.value)} />
              <button onClick={agregar} disabled={guardando || !nuevoConcepto || !nuevoMonto}
                className="bg-[#0b315f] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-[#1262bd] transition-colors flex items-center gap-1.5 disabled:opacity-50">
                <I.Plus size={14} color="white" />{guardando ? "..." : "Agregar"}
              </button>
            </div>
          </div>
        </div>
        <div className="px-5 pb-5">
          <button onClick={cerrar} className="w-full bg-[#0b315f] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#1262bd] transition-colors">Listo</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL REEMPLAZO
// ══════════════════════════════════════════════════════════════════════════════

export function ModalReemplazo({ reservaId, placaOriginal, onClose, onSaved }: { reservaId: number; placaOriginal: string; onClose: () => void; onSaved: () => void }) {
  const [placaNueva, setPlacaNueva] = useState("");
  const [motivo,     setMotivo]     = useState("");
  const [guardando,  setGuardando]  = useState(false);

  const confirmar = async () => {
    if (!placaNueva || !motivo) { alert("Completa placa y motivo"); return; }
    setGuardando(true);
    const { error } = await supabase.from("reservas").update({ unidad_reemplazo_placa: placaNueva.toUpperCase(), reemplazo_motivo: motivo }).eq("id", reservaId);
    setGuardando(false);
    if (error) { alert("Error: " + error.message); return; }
    onSaved(); onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Gestión de Reemplazo</h3>
            <p className="text-xs text-gray-400 mt-0.5">Reserva #{reservaId} · Original: {placaOriginal}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center"><I.X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5">
            <I.Alert size={15} color="#d97706" />
            <p className="text-amber-700 text-xs font-semibold leading-relaxed">Registrar el reemplazo garantiza que la facturación mensual al cliente sea correcta y quede trazado en el historial.</p>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Placa unidad de reemplazo</label>
            <input className="w-full border border-gray-200 rounded-xl px-4 py-3 font-black text-[#0b315f] text-lg tracking-widest text-center uppercase outline-none focus:border-[#0b315f] transition-colors"
              placeholder="EJM-000" value={placaNueva} onChange={e => setPlacaNueva(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Motivo del reemplazo</label>
            <select className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700 outline-none focus:border-[#0b315f] transition-colors" value={motivo} onChange={e => setMotivo(e.target.value)}>
              <option value="">Seleccionar motivo...</option>
              <option>Falla mecánica</option><option>Accidente</option>
              <option>Mantenimiento programado</option><option>Unidad en CITV</option><option>Otro</option>
            </select>
          </div>
          <button onClick={confirmar} disabled={guardando} className="w-full bg-[#0b315f] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#1262bd] transition-colors disabled:opacity-60">
            {guardando ? "Guardando..." : "Confirmar reemplazo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL CHECKLIST
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Checklist de salida. En un servicio YA TERMINADO se abre en modo CONSULTA (`soloLectura`):
 * el checklist es una comprobación PREVIA al despacho, así que marcarlo a toro pasado sería
 * fabricar evidencia — pero impedir verlo es peor todavía, porque lo que se firmó en su día es
 * justamente lo que hay que poder consultar cuando algo salió mal.
 */
export function ModalChecklist({ reservaId, cliente, onClose, onSaved, soloLectura = false }: { reservaId: number; cliente: string; onClose: () => void; onSaved: () => void; soloLectura?: boolean }) {
  const [checked,   setChecked]  = useState<Record<string, boolean>>({});
  const [cargando,  setCargando] = useState(true);
  const [guardando, setGuardando]= useState(false);

  useEffect(() => {
    (async () => {
      setCargando(true);
      const { data } = await supabase.from("checklist_salida").select("*").eq("reserva_id", reservaId);
      const map: Record<string, boolean> = {};
      ((data as ChecklistRow[]) || []).forEach(row => { map[row.item_id] = row.completado; });
      setChecked(map); setCargando(false);
    })();
  }, [reservaId]);

  const toggle = (item: string) => { if (soloLectura) return; setChecked(prev => ({ ...prev, [item]: !prev[item] })); };
  const completados = Object.values(checked).filter(Boolean).length;
  const todoListo   = completados === CHECKLIST_ITEMS.length;

  const guardar = async () => {
    setGuardando(true);
    const rows = CHECKLIST_ITEMS.map(it => ({ reserva_id: reservaId, item_id: it.id, completado: !!checked[it.id], fecha_check: checked[it.id] ? new Date().toISOString() : null }));
    const { error } = await supabase.from("checklist_salida").upsert(rows, { onConflict: "reserva_id,item_id" });
    setGuardando(false);
    if (error) { alert("Error: " + error.message); return; }
    onSaved(); onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Checklist de Salida</h3>
            <p className="text-xs text-gray-400 mt-0.5">Reserva #{reservaId} · {cliente}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center"><I.X size={14} /></button>
        </div>
        <div className="px-5 py-3 border-b border-gray-50 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-gray-500">{completados}/{CHECKLIST_ITEMS.length} verificados</span>
            <span className={`text-xs font-black ${todoListo ? "text-green-600" : "text-gray-400"}`}>{todoListo ? "✓ Listo para salir" : "Pendiente"}</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(completados/CHECKLIST_ITEMS.length)*100}%`, background: todoListo ? "#16a34a" : "#0b315f" }} />
          </div>
        </div>
        <div className="p-5 overflow-y-auto flex-1 space-y-2">
          {cargando ? <p className="text-center text-gray-400 text-sm">Cargando...</p> : CHECKLIST_ITEMS.map(item => (
            <label key={item.id} className={`flex items-center gap-3 p-3 rounded-xl ${soloLectura ? "" : "cursor-pointer"} transition-colors ${checked[item.id] ? "bg-green-50 border border-green-100" : "bg-gray-50 border border-transparent hover:bg-gray-100"}`}>
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${checked[item.id] ? "bg-green-600 border-green-600" : "border-gray-300"}`}>
                {checked[item.id] && <I.Check size={11} color="white" strokeWidth={3} />}
              </div>
              <input type="checkbox" className="hidden" checked={!!checked[item.id]} disabled={soloLectura} onChange={() => toggle(item.id)} />
              <span className={`text-sm font-semibold ${checked[item.id] ? "text-green-700" : "text-gray-600"}`}>{item.label}</span>
            </label>
          ))}
        </div>
        <div className="p-5 border-t border-gray-100 flex-shrink-0">
          {soloLectura ? (
            <p className="text-center text-[11.5px] text-gray-500 leading-snug">
              Servicio terminado: esto es lo que se verificó antes de despachar.
              Un checklist de salida no se puede firmar después de la salida.
            </p>
          ) : (
          <button onClick={guardar} disabled={guardando}
            className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${todoListo ? "bg-green-600 text-white hover:bg-green-700" : "bg-[#0b315f] text-white hover:bg-[#1262bd]"} disabled:opacity-60`}>
            {guardando ? "Guardando..." : todoListo ? "✓ Autorizar salida" : `Guardar avance (${completados}/${CHECKLIST_ITEMS.length})`}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}
