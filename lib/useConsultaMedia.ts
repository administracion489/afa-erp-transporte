"use client";

// lib/useConsultaMedia.ts — ¿La pantalla cumple esta media query? Contesta en el render.
//
// Se lee con useSyncExternalStore y no en un efecto: en el servidor no hay `window`, y el
// snapshot del servidor (false) es el que React usa al hidratar, así que no hay desajuste. El
// layout lo usa para el menú del celular y el CRM para su vista de celular: con la consulta
// escrita en UN sitio, «celular» significa lo mismo en las dos.

import { useCallback, useSyncExternalStore } from "react";

/** Celular: por debajo del breakpoint `md` de Tailwind (768 px). */
export const CONSULTA_PANTALLA_CHICA = "(max-width: 767px)";

/** Pantalla táctil sin ratón (teléfono o tableta): ahí no hay Shift+Enter. */
export const CONSULTA_TACTIL = "(hover: none) and (pointer: coarse)";

const enServidor = () => false;

export function useConsultaMedia(consulta: string): boolean {
  const suscribir = useCallback(
    (aviso: () => void) => {
      const mq = window.matchMedia(consulta);
      mq.addEventListener("change", aviso);
      return () => mq.removeEventListener("change", aviso);
    },
    [consulta],
  );
  const ahora = useCallback(() => window.matchMedia(consulta).matches, [consulta]);
  return useSyncExternalStore(suscribir, ahora, enServidor);
}

export const usePantallaChica = () => useConsultaMedia(CONSULTA_PANTALLA_CHICA);
