"use client";

// lib/flotante-arrastrable.ts — Los botones flotantes (ELIA y la ayuda «?») se arrastran.
//
// Nacieron fijos abajo a la derecha, y ahí tapaban justo lo que más se usa en algunas pantallas:
// el botón «Enviar» del CRM, el pie de una tabla. Ahora se arrastran (ratón o dedo) a cualquier
// parte de la pantalla y se quedan donde se soltaron (localStorage, por navegador: es una
// comodidad de quien mira, no un dato del ERP).
//
// La posición se guarda como distancia al borde DERECHO e INFERIOR, no como x/y: así, al
// agrandar o achicar la ventana, el botón sigue pegado a la misma esquina en vez de quedar
// flotando en medio. Toda posición pasa por `limitarPosicion` antes de pintarse: una guardada en
// un monitor grande no puede dejar el botón fuera de la pantalla del celular.
//
// Un toque es un clic; un arrastre NO abre el panel. La diferencia es el umbral: hasta
// UMBRAL_ARRASTRE_PX de movimiento sigue siendo un toque (un dedo nunca se queda quieto).
// Las funciones de arriba son PURAS (matriz: scripts/prueba-flotantes-composer.mts).

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

export type PosFlotante = { right: number; bottom: number };
export type Ventana = { ancho: number; alto: number };

/** Lo que el botón queda separado del borde, como mínimo, para no pegarse al filo. */
export const MARGEN_FLOTANTE = 8;
/** Movimiento a partir del cual un toque pasa a ser arrastre (un dedo tiembla unos px). */
export const UMBRAL_ARRASTRE_PX = 6;

const finito = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** La posición dentro de la ventana, con su margen. Si la ventana es más chica que el botón,
 *  el botón queda pegado abajo a la derecha (con el margen) en vez de en negativo. */
export function limitarPosicion(pos: PosFlotante, ventana: Ventana, tamano: number): PosFlotante {
  const maxRight = Math.max(MARGEN_FLOTANTE, ventana.ancho - tamano - MARGEN_FLOTANTE);
  const maxBottom = Math.max(MARGEN_FLOTANTE, ventana.alto - tamano - MARGEN_FLOTANTE);
  const r = finito(pos.right) ? pos.right : MARGEN_FLOTANTE;
  const b = finito(pos.bottom) ? pos.bottom : MARGEN_FLOTANTE;
  return {
    right: Math.round(Math.min(Math.max(r, MARGEN_FLOTANTE), maxRight)),
    bottom: Math.round(Math.min(Math.max(b, MARGEN_FLOTANTE), maxBottom)),
  };
}

/** ¿Este movimiento ya es un arrastre o sigue siendo un toque? */
export const esArrastre = (dx: number, dy: number) => Math.hypot(dx, dy) >= UMBRAL_ARRASTRE_PX;

/** Mover el puntero a la derecha ACERCA el botón al borde derecho (resta), y hacia abajo, al inferior. */
export const moverDesde = (inicio: PosFlotante, dx: number, dy: number): PosFlotante => ({
  right: inicio.right - dx,
  bottom: inicio.bottom - dy,
});

/** Lo guardado en localStorage, o null si no es una posición (vacío, corrupto, de otra versión). */
export function leerPosicionGuardada(crudo: string | null | undefined): PosFlotante | null {
  if (!crudo) return null;
  try {
    const p = JSON.parse(crudo) as Partial<PosFlotante> | null;
    if (!p || !finito(p.right) || !finito(p.bottom) || p.right < 0 || p.bottom < 0) return null;
    return { right: p.right, bottom: p.bottom };
  } catch {
    return null;
  }
}

/** Ancho por debajo del cual la pantalla es de celular (el breakpoint `md`, como lib/useConsultaMedia.ts). */
export const ANCHO_CELULAR = 768;

/** Dónde nace el botón si nadie lo movió. En el celular va más arriba: abajo a la derecha tapaba el
 *  botón «Enviar» del chat del CRM, y en un teléfono no hay hover que avise que se puede arrastrar. */
export function posicionInicial(ventana: Ventana, inicial: { escritorio: PosFlotante; celular: PosFlotante }): PosFlotante {
  return ventana.ancho > 0 && ventana.ancho < ANCHO_CELULAR ? inicial.celular : inicial.escritorio;
}

/** Lado de los dos botones (ELIA y el «?»), en px. */
export const TAMANO_FLOTANTE = 54;

/** ELIA: en escritorio donde siempre (bottom-5 right-5); en el celular, pegada al borde derecho y por
 *  encima del cuadro de respuesta del CRM (~110 px de alto con su fila de herramientas). */
export const INICIAL_ELIA = { escritorio: { right: 20, bottom: 20 }, celular: { right: 12, bottom: 140 } };

/** El «?»: en escritorio a la izquierda de ELIA (bottom-5 right-24); en el celular, encima de ELIA. */
export const INICIAL_AYUDA = { escritorio: { right: 96, bottom: 20 }, celular: { right: 12, bottom: 202 } };

/** De qué lado del botón cabe la etiqueta que sale al pasar el ratón: hacia el centro de la pantalla. */
export function ladoEtiqueta(pos: PosFlotante, ventana: Ventana, tamano: number): "izquierda" | "derecha" {
  const centroDesdeIzquierda = ventana.ancho - pos.right - tamano / 2;
  return centroDesdeIzquierda < ventana.ancho / 2 ? "derecha" : "izquierda";
}

// ── El hook ─────────────────────────────────────────────────────────────────

const ventanaActual = (): Ventana => ({
  // Sin la barra de scroll: `right: 0` de un fixed se mide desde ella, no desde el borde físico.
  ancho: document.documentElement.clientWidth || window.innerWidth,
  alto: document.documentElement.clientHeight || window.innerHeight,
});

type Inicial = { escritorio: PosFlotante; celular: PosFlotante };

/** Dónde lo dejó la persona la última vez (o donde nace), ya dentro de esta ventana. */
function estadoInicial(clave: string, inicial: Inicial, tamano: number): { pos: PosFlotante; ventana: Ventana } {
  if (typeof window === "undefined") return { pos: inicial.escritorio, ventana: { ancho: 0, alto: 0 } };
  let guardada: PosFlotante | null = null;
  try { guardada = leerPosicionGuardada(window.localStorage.getItem(clave)); } catch { /* sin storage: nace en su sitio */ }
  const ventana = ventanaActual();
  return { pos: limitarPosicion(guardada ?? posicionInicial(ventana, inicial), ventana, tamano), ventana };
}

/**
 * Estado y manejadores para un botón flotante arrastrable. `clave` es la de localStorage
 * (una por botón), `inicial` dónde nace en escritorio y en celular, y `tamano` su lado en px (para
 * no salirse de la pantalla).
 *
 * La posición guardada se lee al CREAR el estado, no en un efecto: así el primer cuadro ya pinta el
 * botón donde va (un efecto lo pintaría un instante en su sitio de escritorio y después lo movería).
 * Por eso el componente que lo usa se monta solo en el navegador (ELIA y la ayuda van con
 * `dynamic(..., { ssr: false })` en app/layout.tsx); en el servidor nace en su sitio de escritorio.
 * El layout remonta los flotantes en cada ruta, así que cada pantalla lee lo último guardado.
 *
 * Uso: `style={{ right: pos.right, bottom: pos.bottom }}`, `{...manejadores}` en el botón, y en su
 * onClick primero `if (consumirClic()) return;` — el clic que llega al soltar un arrastre no abre nada.
 */
export function useFlotanteArrastrable(clave: string, inicial: Inicial, tamano: number) {
  const [{ pos, ventana }, setEstado] = useState(() => estadoInicial(clave, inicial, tamano));
  const [arrastrando, setArrastrando] = useState(false);
  // Copia de `pos` para los manejadores (que no se recrean en cada movimiento). Se escribe junto
  // con el estado, nunca durante el render.
  const posRef = useRef(pos);
  const fijar = useCallback((p: PosFlotante, v?: Ventana) => {
    posRef.current = p;
    setEstado((e) => ({ pos: p, ventana: v ?? e.ventana }));
  }, []);
  const gesto = useRef<{ x: number; y: number; desde: PosFlotante; puntero: number } | null>(null);
  const huboArrastre = useRef(false);

  // Que no quede fuera si la ventana cambia (girar el teléfono, achicar el navegador).
  useEffect(() => {
    const alCambiar = () => {
      const v = ventanaActual();
      fijar(limitarPosicion(posRef.current, v, tamano), v);
    };
    window.addEventListener("resize", alCambiar);
    return () => window.removeEventListener("resize", alCambiar);
  }, [tamano, fijar]);

  const guardar = useCallback((p: PosFlotante) => {
    try { window.localStorage.setItem(clave, JSON.stringify(p)); } catch { /* se queda solo en esta pantalla */ }
  }, [clave]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    huboArrastre.current = false;
    gesto.current = { x: e.clientX, y: e.clientY, desde: posRef.current, puntero: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* sin captura, el arrastre sigue mientras el puntero esté encima */ }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const g = gesto.current;
    if (!g || g.puntero !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!huboArrastre.current) {
      if (!esArrastre(dx, dy)) return;
      huboArrastre.current = true;
      setArrastrando(true);
    }
    fijar(limitarPosicion(moverDesde(g.desde, dx, dy), ventanaActual(), tamano));
  }, [tamano, fijar]);

  const terminar = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const g = gesto.current;
    if (!g || g.puntero !== e.pointerId) return;
    gesto.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ya estaba suelto */ }
    if (!huboArrastre.current) return;
    setArrastrando(false);
    guardar(posRef.current);
    // El clic de soltar llega justo después, en este mismo turno: ese lo traga `consumirClic`. Si
    // el navegador no lo manda (un dedo que se movió mucho), la marca se borra igual y no se come
    // el siguiente clic de verdad (el de teclado, que no pasa por onPointerDown).
    window.setTimeout(() => { huboArrastre.current = false; }, 0);
  }, [guardar]);

  /** true si el clic que acaba de llegar es el de soltar un arrastre (y entonces no hay que abrir nada). */
  const consumirClic = useCallback(() => {
    const fue = huboArrastre.current;
    huboArrastre.current = false;
    return fue;
  }, []);

  return {
    pos,
    arrastrando,
    lado: ventana.ancho ? ladoEtiqueta(pos, ventana, tamano) : ("izquierda" as const),
    consumirClic,
    manejadores: { onPointerDown, onPointerMove, onPointerUp: terminar, onPointerCancel: terminar },
  };
}
