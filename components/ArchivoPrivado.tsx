"use client";
// components/ArchivoPrivado.tsx — Pintar y abrir archivos de los buckets PRIVADOS desde el ERP.
//
// Las pantallas guardan en su estado el enlace tal como está en la base (el público, que ya no
// abre nada: ver lib/storage-privado.ts) y SOLO al pintar se cambia por uno firmado. Eso es lo que
// impide la trampa de este cambio: varias pantallas devuelven a la base el valor que tienen en el
// estado (el formulario de un documento de proveedor, la corrección de una lectura del Radar, la
// ficha del pasajero), y si el estado guardara el firmado se escribiría en la base un enlace que
// caduca en una hora.
//
// `<ImgPrivada>` y `<EnlacePrivado>` son un `<img>` y un `<a>` con la misma API: cambiar la
// etiqueta es todo el cambio en cada pantalla. Lo que no es de un bucket privado (Drive,
// `vehiculos-fotos`) pasa tal cual, sin esperar nada.
//
// Se firma EN LOTE (una petición por bucket para todo lo que se pinta en el mismo instante: el feed
// del Radar son 150 mensajes) y con caché: una pantalla que se refresca con cada evento realtime no
// vuelve a firmar lo que ya firmó. El enlace se renueva solo antes de caducar mientras la pantalla
// siga abierta, para que un «Ver» pulsado a la hora siga abriendo.

import { useEffect, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes } from "react";
import { supabase } from "@/lib/supabase";
import { objetoPrivadoDe, baseSupabase } from "@/lib/storage-privado";
import { firmarUrls, TTL_FIRMA_SEG } from "@/lib/storage-firmado";

/** Se renueva a los 50 min de una firma de 60: margen para el reloj del equipo y la red. */
const VIGENCIA_MS = (TTL_FIRMA_SEG - 600) * 1000;
/** Si firmar falla (p. ej. el SQL aún no se corrió) se usa el original y se reintenta pronto. */
const REINTENTO_MS = 60 * 1000;

const cache = new Map<string, { url: string; hasta: number }>();
let cola = new Map<string, Array<(u: string) => void>>();
let programado = false;

const esPrivado = (url: string | null | undefined): url is string =>
  !!url && objetoPrivadoDe(url, baseSupabase()) != null;

function leerCache(url: string): string | null {
  const c = cache.get(url);
  return c && c.hasta > Date.now() ? c.url : null;
}

async function vaciarCola() {
  programado = false;
  const pendientes = cola;
  cola = new Map();
  const urls = [...pendientes.keys()];
  let mapa = new Map<string, string>();
  try { mapa = await firmarUrls(supabase, urls); } catch { /* se usan los originales */ }
  const ahora = Date.now();
  for (const url of urls) {
    const firmada = mapa.get(url) ?? url;
    // Si volvió el original es que no se pudo firmar: vale poco tiempo, para reintentar.
    cache.set(url, { url: firmada, hasta: ahora + (firmada === url ? REINTENTO_MS : VIGENCIA_MS) });
    for (const cb of pendientes.get(url) ?? []) cb(firmada);
  }
}

/** El enlace utilizable de un archivo. Para lo que no es de un bucket privado, el mismo. */
export function firmarEnNavegador(url: string): Promise<string> {
  if (!esPrivado(url)) return Promise.resolve(url);
  const enCache = leerCache(url);
  if (enCache) return Promise.resolve(enCache);
  return new Promise((resolve) => {
    cola.set(url, [...(cola.get(url) ?? []), resolve]);
    if (!programado) {
      programado = true;
      // Un tick: junta todo lo que se monta en el mismo render en UNA petición.
      setTimeout(() => { void vaciarCola(); }, 0);
    }
  });
}

/**
 * El enlace listo para pintar. `null` mientras se firma (el `<img>` y el `<a>` esperan sin src ni
 * href en vez de pedir un enlace que ya no abre). Lo que no es privado vuelve igual y al instante.
 */
export function useUrlFirmada(url: string | null | undefined): string | null | undefined {
  const privado = esPrivado(url);
  const [firmada, setFirmada] = useState<{ de: string; url: string } | null>(null);

  useEffect(() => {
    if (!privado || !url) return;
    let vivo = true;
    let reloj: ReturnType<typeof setTimeout> | null = null;
    const pedir = () => {
      firmarEnNavegador(url).then((u) => {
        if (!vivo) return;
        setFirmada({ de: url, url: u });
        // Renovar antes de que caduque mientras siga montado.
        const c = cache.get(url);
        const ms = c ? Math.max(1000, c.hasta - Date.now()) : REINTENTO_MS;
        // Hasta que llegue el nuevo, se sigue enseñando el anterior (todavía vale 10 min).
        reloj = setTimeout(() => { if (vivo) pedir(); }, ms);
      });
    };
    pedir();
    return () => { vivo = false; if (reloj) clearTimeout(reloj); };
  }, [url, privado]);

  if (!privado) return url;
  const enCache = leerCache(url);
  if (enCache) return enCache;
  return firmada && firmada.de === url ? firmada.url : null;
}

type ImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src?: string | null };

/** `<img>` que firma su `src` si es de un bucket privado. */
export function ImgPrivada({ src, style, ...resto }: ImgProps) {
  const url = useUrlFirmada(src ?? null);
  return (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      {...resto}
      src={url ?? undefined}
      // Mientras se firma no se enseña el texto alternativo ni el ícono de imagen rota.
      style={url ? style : { ...style, visibility: "hidden" }}
    />
  );
}

type AProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href?: string | null };

/** `<a>` que firma su `href` si es de un bucket privado. */
export function EnlacePrivado({ href, children, ...resto }: AProps) {
  const url = useUrlFirmada(href ?? null);
  return (
    <a {...resto} href={url ?? undefined} aria-disabled={url ? undefined : true}>
      {children}
    </a>
  );
}
