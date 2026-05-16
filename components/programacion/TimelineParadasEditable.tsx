"use client";

import React, { useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type ParadaEditable = {
  id: number;
  reserva_id: number;
  orden: number;
  nombre: string;
  direccion: string | null;
  hora_estimada: string | null;
  lat?: number | null;
  lng?: number | null;
  estado?: string | null;
};

type Props = {
  reservaId: number;
  paradas: ParadaEditable[];
  onChange?: () => void;
  compacto?: boolean;
};

// Item sortable individual
function ParadaItem(props: {
  parada: ParadaEditable;
  index: number;
  total: number;
  compacto: boolean;
  onEditar?: (id: number) => void;
  onEliminar?: (id: number) => void;
}) {
  const { parada, index, total, compacto } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: parada.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : 1,
  };

  const esInicio = index === 0;
  const esDestino = index === total - 1;
  const completada = parada.estado === "completada";

  let colorPunto = "#0b315f";
  let bgPunto = "white";
  let colorTxt = "#0b315f";
  if (completada) { colorPunto = "#0b315f"; bgPunto = "#0b315f"; colorTxt = "white"; }
  else if (esInicio) { colorPunto = "#16a34a"; bgPunto = "#16a34a"; colorTxt = "white"; }
  else if (esDestino) { colorPunto = "#dc2626"; bgPunto = "#dc2626"; colorTxt = "white"; }

  let tipoLabel = "Intermedia";
  let tipoBg = "#eef3f8";
  let tipoColor = "#0b315f";
  if (completada) { tipoLabel = "Completada"; tipoBg = "#dcfce7"; tipoColor = "#166534"; }
  else if (esInicio) { tipoLabel = "Inicio"; tipoBg = "#f0fdf4"; tipoColor = "#16a34a"; }
  else if (esDestino) { tipoLabel = "Destino"; tipoBg = "#fee2e2"; tipoColor = "#dc2626"; }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-gray-300 hover:text-gray-600 hover:bg-gray-100 cursor-grab active:cursor-grabbing"
        title="Arrastra para reordenar"
        aria-label="Reordenar parada"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>

      {/* Numero / dot */}
      <div
        className="flex-shrink-0 w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-black"
        style={{ background: bgPunto, borderColor: colorPunto, color: colorTxt }}
      >
        {completada ? "v" : index + 1}
      </div>

      {/* Info parada */}
      <div className={"flex-1 min-w-0 rounded-xl border bg-white " + (compacto ? "px-3 py-2" : "p-3")}
        style={{ borderColor: isDragging ? "#0b315f" : "#e2e8f0", boxShadow: isDragging ? "0 4px 12px rgba(11,49,95,0.15)" : "none" }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className={"font-bold text-gray-900 truncate " + (compacto ? "text-xs" : "text-sm")}>{parada.nombre}</p>
            {!compacto && parada.direccion ? (
              <p className="text-gray-400 text-xs mt-0.5 truncate">{parada.direccion}</p>
            ) : null}
            <div className="flex gap-3 mt-0.5 text-[10px] flex-wrap">
              {parada.hora_estimada ? (
                <span className="text-gray-500">{parada.hora_estimada}</span>
              ) : null}
              {!compacto && parada.lat && parada.lng ? (
                <a
                  href={"https://www.google.com/maps?q=" + parada.lat + "," + parada.lng}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-500 font-bold hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Ver en mapa
                </a>
              ) : null}
            </div>
          </div>
          <span
            className="flex-shrink-0 font-bold px-2 py-0.5 rounded-full text-[10px]"
            style={{ background: tipoBg, color: tipoColor }}
          >
            {tipoLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function TimelineParadasEditable(props: Props) {
  const { reservaId, paradas: paradasIniciales, onChange, compacto } = props;
  const [items, setItems] = useState<ParadaEditable[]>(paradasIniciales);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "err"; texto: string } | null>(null);

  // Sincronizar cuando cambian las paradas externas
  React.useEffect(() => {
    setItems(paradasIniciales);
  }, [paradasIniciales]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((p) => p.id === active.id);
    const newIndex = items.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Actualizacion optimista del UI
    const reordenados = arrayMove(items, oldIndex, newIndex).map((p, i) => ({
      ...p,
      orden: i + 1,
    }));
    setItems(reordenados);

    // Guardar en BD
    setGuardando(true);
    setMensaje(null);

    const payload = reordenados.map((p) => ({ id: p.id, orden: p.orden }));

    const { error } = await supabase.rpc("reordenar_paradas", {
      p_reserva_id: reservaId,
      p_nuevo_orden: payload,
    });

    setGuardando(false);

    if (error) {
      // Rollback
      setItems(paradasIniciales);
      setMensaje({ tipo: "err", texto: "Error al guardar: " + error.message });
      return;
    }

    setMensaje({ tipo: "ok", texto: "Itinerario actualizado" });
    setTimeout(() => setMensaje(null), 2500);
    if (onChange) onChange();
  };

  if (items.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed p-4 text-center text-xs text-gray-400">
        Sin paradas configuradas
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Mensaje flotante */}
      {mensaje ? (
        <div
          className="rounded-lg px-3 py-2 text-xs font-bold flex items-center justify-between"
          style={{
            background: mensaje.tipo === "ok" ? "#dcfce7" : "#fee2e2",
            color: mensaje.tipo === "ok" ? "#166534" : "#991b1b",
          }}
        >
          <span>{guardando ? "Guardando..." : mensaje.texto}</span>
          <button onClick={() => setMensaje(null)} className="opacity-60 hover:opacity-100">X</button>
        </div>
      ) : null}

      {guardando && !mensaje ? (
        <div className="rounded-lg px-3 py-2 text-xs font-bold bg-blue-50 text-blue-700 flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-blue-200 border-t-blue-700 rounded-full animate-spin" />
          Reordenando paradas...
        </div>
      ) : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div className={compacto ? "space-y-1.5" : "space-y-2"}>
            {items.map((p, i) => (
              <ParadaItem
                key={p.id}
                parada={p}
                index={i}
                total={items.length}
                compacto={compacto || false}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <p className="text-[10px] text-gray-400 italic mt-2">
        Tip: arrastra desde el icono de la izquierda para reordenar
      </p>
    </div>
  );
}