"use client";
// components/cotizaciones/useCampoSinIgv.ts
// El campo SIN IGV de un par «sin IGV / con IGV» del formulario de cotizaciones.
//
// El estado del formulario guarda SOLO el con IGV (lib/igv-par.ts). Este campo no tiene estado
// propio mientras nadie lo toca: pinta lo que se deriva del con IGV, así sigue a cualquier otro
// camino que lo cambie (los botones del calculador, reabrir una cotización, pasar a dólares).
// Mientras se escribe en él, se enseña lo tecleado tal cual —si se derivara en cada tecla, «298.»
// se volvería «298» y no se podría escribir el decimal— y cada tecla actualiza el con IGV.

import { useState, type ChangeEvent } from "react";
import { textoConDesdeSin, textoSinDesdeCon } from "@/lib/igv-par";

export function useCampoSinIgv(con: string, onCon: (texto: string) => void) {
  const [tecleado, setTecleado] = useState<string | null>(null);
  return {
    value: tecleado ?? textoSinDesdeCon(con),
    onFocus: () => setTecleado(textoSinDesdeCon(con)),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setTecleado(e.target.value);
      onCon(textoConDesdeSin(e.target.value));
    },
    onBlur: () => setTecleado(null),
  };
}
