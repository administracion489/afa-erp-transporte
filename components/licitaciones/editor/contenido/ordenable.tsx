"use client";
// components/licitaciones/editor/contenido/ordenable.tsx — Arrastrar para reordenar (secciones y bloques)
// con @dnd-kit, que el repo ya usa en components/programacion/TimelineParadasEditable.tsx. Solo se arrastra
// desde el asa (⠿): los campos de texto de dentro siguen funcionando. Con teclado: foco en el asa, Espacio,
// flechas y Espacio. Los botones ↑ ↓ de cada elemento siguen ahí para el celular y para quien no arrastra.

import { useId, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, type useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export function ContenedorOrdenable({ ids, mover, children }: { ids: string[]; mover: (de: number, a: number) => void; children: ReactNode }) {
  const id = useId();
  const sensores = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const alSoltar = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const de = ids.indexOf(String(e.active.id)), a = ids.indexOf(String(e.over.id));
    if (de >= 0 && a >= 0) mover(de, a);
  };
  return (
    <DndContext id={id} sensors={sensores} collisionDetection={closestCenter} onDragEnd={alSoltar}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>{children}</SortableContext>
    </DndContext>
  );
}

/**
 * Estilo de un elemento mientras se arrastra. Cada elemento llama a `useSortable` DIRECTAMENTE (como
 * TimelineParadasEditable): envuelto en un hook propio, el compilador de React toma el resultado entero
 * por una ref y prohíbe leerlo al pintar.
 */
export function estiloOrdenable(s: Pick<ReturnType<typeof useSortable>, "transform" | "transition" | "isDragging">) {
  return { transform: CSS.Translate.toString(s.transform), transition: s.transition, zIndex: s.isDragging ? 20 : undefined, position: "relative" as const };
}

export function Asa({ atributos, escuchas, etiqueta }: { atributos: DraggableAttributes; escuchas: DraggableSyntheticListeners; etiqueta: string }) {
  return (
    <button type="button" {...atributos} {...escuchas} title={`Arrastra para reordenar ${etiqueta}`} aria-label={`Reordenar ${etiqueta}`}
      className="inline-flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-gray-300 hover:bg-gray-100 hover:text-gray-600 active:cursor-grabbing">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
        <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
        <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
      </svg>
    </button>
  );
}
