"use client";
// components/licitaciones/editor/contexto-editor.tsx — Lo que el editor expone a los pasos ADEMÁS de
// PasoProps (contrato-editor.ts), sin cambiar el contrato: el estado del guardado, guardar YA (lo
// necesita quien depende de lo GUARDADO, como la lectura con IA, que el servidor hace desde la fila) y
// el destino de la última navegación (para que un paso despliegue el elemento al que se va).
//
// Uso en un paso:  const { pendiente, guardarAhora, ancla } = useEditorExtra();
import { createContext, useContext } from "react";

export type FaseGuardado =
  | "guardado"      // todo lo de la pantalla está en la base
  | "sin_guardar"   // hay cambios y el guardado automático los va a mandar
  | "guardando"     // un guardado en vuelo
  | "error"         // el último guardado falló (se reintenta con el próximo cambio o con Guardar)
  | "conflicto"     // otra persona guardó: el guardado automático se detuvo
  | "solo_lectura"; // archivada o sin permiso de escritura

export type DestinoAncla = {
  /** Ids del DOM candidatos (navegacion.ts → candidatosAncla): el elemento y, de respaldo, su panel. */
  ids: string[];
  /** Cambia en cada navegación, aunque el destino sea el mismo. */
  n: number;
};

export type EditorExtra = {
  fase: FaseGuardado;
  /** Hay cambios que la base todavía no tiene (sin guardar o en vuelo). */
  pendiente: boolean;
  errorGuardado: string | null;
  /**
   * Guarda YA lo que haya pendiente (espera al guardado en vuelo, si lo hay). Resuelve `true` solo si al
   * terminar no queda nada sin guardar; `false` con conflicto, error, solo lectura o cambios nuevos.
   */
  guardarAhora: () => Promise<boolean>;
  ancla: DestinoAncla | null;
};

const Contexto = createContext<EditorExtra | null>(null);

export const ProveedorEditorExtra = Contexto.Provider;

/** El estado del editor para un paso. Fuera del editor (p. ej. una matriz) devuelve un valor inerte. */
export function useEditorExtra(): EditorExtra {
  return useContext(Contexto) ?? INERTE;
}

const INERTE: EditorExtra = {
  fase: "guardado", pendiente: false, errorGuardado: null, guardarAhora: async () => false, ancla: null,
};

/** ¿La navegación apunta a este elemento? (para desplegarlo). */
export function apuntaA(ancla: DestinoAncla | null, id: string): boolean {
  return !!ancla && ancla.ids.includes(id);
}
