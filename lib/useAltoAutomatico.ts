"use client";

// lib/useAltoAutomatico.ts — El cuadro de texto crece con lo que se escribe, como en WhatsApp.
//
// El cuadro de respuesta del CRM medía siempre dos renglones: al escribir un mensaje de varias
// líneas, el texto se iba por arriba y había que desplazarse dentro de un hueco de dos renglones
// para releerlo. Ahora crece renglón a renglón hasta `maxFilas` y, pasado ese alto, aparece la
// barra de desplazamiento (la de WhatsApp Web crece así hasta unas ocho líneas).
//
// El cálculo es PURO (`altoAutomatico`, matriz: scripts/prueba-flotantes-composer.mts); el hook
// solo mide. Se mide con `height: auto` + `scrollHeight`, que es el alto real del contenido con
// su relleno: el `rows` del textarea queda como mínimo natural.

import { useCallback, useEffect, useLayoutEffect } from "react";

export type MedidaTextarea = {
  /** `scrollHeight` con `height: auto`: el contenido más el relleno, sin el borde. */
  contenido: number;
  /** Alto de un renglón (line-height en px). */
  linea: number;
  /** Relleno vertical (arriba + abajo). */
  relleno: number;
  /** Borde vertical (arriba + abajo): con box-sizing border-box, el alto lo incluye. */
  borde: number;
  minFilas: number;
  maxFilas: number;
};

/** El alto que le toca al cuadro (px, border-box) y si hace falta la barra de desplazamiento. */
export function altoAutomatico(m: MedidaTextarea): { alto: number; conScroll: boolean } {
  const linea = m.linea > 0 ? m.linea : 20;
  const minFilas = Math.max(1, Math.floor(m.minFilas));
  const maxFilas = Math.max(minFilas, Math.floor(m.maxFilas));
  const marco = Math.max(0, m.relleno) + Math.max(0, m.borde);
  const minimo = linea * minFilas + marco;
  const maximo = linea * maxFilas + marco;
  const natural = Math.max(0, m.contenido) + Math.max(0, m.borde);
  return {
    alto: Math.ceil(Math.min(Math.max(natural, minimo), maximo)),
    // Medio renglón de tolerancia: el redondeo de subpíxeles no es «hay más texto».
    conScroll: natural > maximo + linea / 2,
  };
}

const px = (v: string) => parseFloat(v) || 0;

/**
 * Ajusta el alto de un textarea a su contenido. Devuelve un ref de callback que también llena
 * `ref` (el que la pantalla usa para enfocar): así el cuadro se mide también cuando aparece de
 * nuevo (otra conversación) con texto ya escrito, y no solo cuando cambia el texto.
 */
export function useAltoAutomatico(
  ref: { current: HTMLTextAreaElement | null },
  valor: string,
  { minFilas = 1, maxFilas = 8 }: { minFilas?: number; maxFilas?: number } = {},
) {
  const ajustar = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const linea = px(cs.lineHeight) || px(cs.fontSize) * 1.25;
    el.style.height = "auto";
    const { alto, conScroll } = altoAutomatico({
      contenido: el.scrollHeight,
      linea,
      relleno: px(cs.paddingTop) + px(cs.paddingBottom),
      borde: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
      minFilas,
      maxFilas,
    });
    el.style.height = `${alto}px`;
    el.style.overflowY = conScroll ? "auto" : "hidden";
  }, [ref, minFilas, maxFilas]);

  // Antes de pintar: si no, se vería un cuadro del alto viejo con el texto nuevo.
  useLayoutEffect(() => { ajustar(); }, [valor, ajustar]);

  // Otro ancho reparte el texto en otros renglones (girar el teléfono, abrir el menú).
  useEffect(() => {
    window.addEventListener("resize", ajustar);
    return () => window.removeEventListener("resize", ajustar);
  }, [ajustar]);

  return useCallback((el: HTMLTextAreaElement | null) => {
    ref.current = el;
    if (el) ajustar();
  }, [ref, ajustar]);
}
