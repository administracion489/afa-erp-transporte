// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/renombrar-categoria.ts — Cambiar la CLAVE de una categoría de traslado (VAN_15 →
// VAN_17). Motor PURO: qué se puede renombrar, qué pasa con cada foto y con cada cotización. Lo
// ejecuta `lib/traslados/renombrar-categoria-datos.ts` desde POST /api/traslados/categorias/renombrar.
//
// LA CLAVE ES UNA IDENTIDAD Y VIVE EN TRES SITIOS. Renombrarla en uno solo deja los otros dos
// apuntando a una clave que ya no existe (escribir con una identidad y leer con otra):
//  1. `tarifas_traslado.categoria` — FK `on update cascade` (traslados-01): la base la mueve sola.
//  2. Las FOTOS de la categoría: su ruta es `categorias/<CLAVE>/<lado>-<uuid>.jpg`, y el PDF y
//     «Quitar» solo aceptan una foto DE ESA categoría (`rutaDeUrlFoto` con `esperado`; es lo que
//     impide que una categoría borre la foto de otra). Una foto que se quedara en la carpeta vieja
//     dejaría de salir en el PDF. Por eso se COPIA a la carpeta nueva con el MISMO nombre (uuid) y
//     la columna pasa a la URL nueva en el mismo UPDATE que cambia la clave.
//  3. `cotizaciones.traslado_json.categoria.clave` — una copia sin FK: con ella el PDF de una
//     cotización ya guardada busca las fotos y la descripción de su vehículo, y `resultadoDeFila`
//     vuelve a decidir si una pendiente cuadra con el tarifario. Se reescribe SOLO la clave; el
//     nombre y la capacidad que se cotizaron se quedan como estaban (son lo que se le dijo al cliente).
//
// LA CLAVE NO LA VE EL CLIENTE: el PDF, el mensaje de la IA y el simulador enseñan el NOMBRE.
// ──────────────────────────────────────────────────────────────────────────────

import { normalizarClaveCategoria } from "@/components/tarifario/traslados-pantalla";
import { RE_RUTA_FOTO, claveValida, rutaDeUrlFoto, type LadoFoto } from "./fotos-categoria";

export type CodigoRenombre = "ok" | "vacia" | "igual" | "no_existe" | "ya_existe";

export type RevisionRenombre =
  | { ok: true; codigo: "ok"; de: string; a: string; detalle: "" }
  | { ok: false; codigo: Exclude<CodigoRenombre, "ok">; de: string; a: string; detalle: string };

/**
 * ¿Se puede pasar `de` a la clave tecleada? `claves` son las que existen hoy. La clave nueva se
 * normaliza igual que al crear una categoría (MAYÚSCULAS, sin tildes, espacios como «_»).
 */
export function revisarRenombre(de: string, aTecleada: string, claves: readonly string[]): RevisionRenombre {
  const a = normalizarClaveCategoria(String(aTecleada ?? "").trim());
  const mal = (codigo: Exclude<CodigoRenombre, "ok">, detalle: string): RevisionRenombre => ({ ok: false, codigo, de, a, detalle });
  // Sin una letra o un número no es una clave (`__` saldría de unos espacios y signos sueltos).
  if (!claveValida(a) || !/[A-Z0-9]/.test(a)) return mal("vacia", "Escribe la clave nueva (MAYÚSCULAS, sin espacios; p. ej. VAN_17).");
  if (a === de) return mal("igual", `La clave ya es ${de}.`);
  if (!claves.includes(de)) return mal("no_existe", `No existe la categoría ${de}: recarga la pantalla.`);
  if (claves.includes(a)) return mal("ya_existe", `Ya existe la clave ${a}: elige otra.`);
  return { ok: true, codigo: "ok", de, a, detalle: "" };
}

/**
 * Qué pasa con la foto de un lado al renombrar:
 *  · `sin_foto` — la columna está vacía.
 *  · `mover`    — es una foto de ESTA categoría y ESTE lado: se copia de `desde` a `hasta` (misma
 *                 carpeta del bucket con la clave nueva y el mismo nombre de archivo).
 *  · `ajena`    — la URL no es una foto de esta categoría (otro host, otra forma, otra clave): el PDF
 *                 ya no la usa hoy, y renombrar no la vuelve buena. Se deja tal cual y se avisa.
 */
export type PlanFoto =
  | { codigo: "sin_foto" }
  | { codigo: "mover"; desde: string; hasta: string }
  | { codigo: "ajena" };

export function planFoto(url: unknown, supabaseUrl: string | null | undefined, de: string, a: string, lado: LadoFoto): PlanFoto {
  if (url == null || (typeof url === "string" && !url.trim())) return { codigo: "sin_foto" };
  const desde = rutaDeUrlFoto(url, supabaseUrl, { clave: de, lado });
  if (!desde || !claveValida(a)) return { codigo: "ajena" };
  const carpeta = `categorias/${de}/`;
  if (!desde.startsWith(carpeta)) return { codigo: "ajena" };
  const hasta = `categorias/${a}/${desde.slice(carpeta.length)}`;
  const m = RE_RUTA_FOTO.exec(hasta);
  if (!m || m[1] !== a || m[2] !== lado) return { codigo: "ajena" };
  return { codigo: "mover", desde, hasta };
}

/**
 * El `traslado_json` de una cotización con la clave nueva, o null si no es de la categoría `de`
 * (no se toca). Solo cambia `categoria.clave`: el nombre y la capacidad cotizados se conservan.
 */
export function trasladoJsonRenombrado(tj: unknown, de: string, a: string): Record<string, unknown> | null {
  if (!tj || typeof tj !== "object" || Array.isArray(tj)) return null;
  const cat = (tj as Record<string, unknown>).categoria;
  if (!cat || typeof cat !== "object" || Array.isArray(cat)) return null;
  if ((cat as Record<string, unknown>).clave !== de) return null;
  return { ...(tj as Record<string, unknown>), categoria: { ...(cat as Record<string, unknown>), clave: a } };
}

/** Lo que va a pasar, para enseñarlo antes del botón. `cotizaciones` null = no se pudo contar. */
export type PreviaRenombre = { tarifas: number | null; fotos: number; cotizaciones: number | null };

/** Las frases del plan, una por efecto. Las cifras desconocidas se dicen como tales, nunca como 0. */
export function frasesPlan(de: string, a: string, p: PreviaRenombre): string[] {
  const out = [
    p.tarifas == null ? `Los precios de ${de} pasan a ${a} (no se pudieron contar). Ningún importe cambia.`
      : p.tarifas === 0 ? `${de} no tiene precios cargados.`
        : `${p.tarifas === 1 ? "El precio" : `Los ${p.tarifas} precios`} de ${de} ${p.tarifas === 1 ? "pasa" : "pasan"} a ${a}. Ningún importe cambia.`,
  ];
  if (p.fotos > 0) out.push(`${p.fotos === 1 ? "Su foto se mueve" : `Sus ${p.fotos} fotos se mueven`} a la carpeta de ${a} (las mismas fotos).`);
  if (p.cotizaciones == null) out.push(`Las cotizaciones guardadas con ${de} se actualizan (no se pudieron contar).`);
  else if (p.cotizaciones > 0) out.push(`${p.cotizaciones === 1 ? "1 cotización guardada" : `${p.cotizaciones} cotizaciones guardadas`} con ${de} pasan a ${a}, para que su PDF siga saliendo con las fotos del vehículo. Lo que se le cotizó al cliente (nombre, capacidad, precio) no cambia.`);
  out.push("El nombre, los asientos, la bodega y la ficha de costeo no cambian: se editan en la tabla.");
  return out;
}
