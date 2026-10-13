// components/monitoreo/usePreferencia.ts — una preferencia booleana de ESTE navegador (localStorage).
//
// Es una comodidad por usuario (p. ej. «mostrar las estacionadas»), nunca un dato que deba
// sobrevivir: en una ventana privada, con el almacenamiento bloqueado o en una vista previa el
// acceso puede lanzar, y entonces vale el defecto (o lo elegido, mientras la página siga abierta).
// Se lee con useSyncExternalStore y no en un efecto: el primer render ya trae el valor guardado.

import { useCallback, useSyncExternalStore } from "react";

const avisos = new Set<() => void>();
/** Lo elegido en esta pestaña: manda si el almacenamiento no deja escribir. */
const elegido = new Map<string, boolean>();

function leer(clave: string, defecto: boolean): boolean {
  try {
    const v = window.localStorage.getItem(clave);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch { /* almacenamiento bloqueado */ }
  return elegido.get(clave) ?? defecto;
}

function suscribir(aviso: () => void): () => void {
  avisos.add(aviso);
  window.addEventListener("storage", aviso);
  return () => {
    avisos.delete(aviso);
    window.removeEventListener("storage", aviso);
  };
}

export function usePreferenciaBool(clave: string, defecto: boolean): [boolean, (v: boolean) => void] {
  const valor = useSyncExternalStore(suscribir, () => leer(clave, defecto), () => defecto);
  const cambiar = useCallback((v: boolean) => {
    elegido.set(clave, v);
    try { window.localStorage.setItem(clave, v ? "1" : "0"); } catch { /* vale `elegido` */ }
    avisos.forEach((a) => a());
  }, [clave]);
  return [valor, cambiar];
}
