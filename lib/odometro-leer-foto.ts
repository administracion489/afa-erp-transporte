// lib/odometro-leer-foto.ts — «🤖 Leer foto con IA» del tablero, desde el NAVEGADOR.
//
// Estaba copiado literal en /mantenimiento → Odómetro y en el modal de odómetro de /tercerizadas, y
// /combustible lo necesita para la foto del tablero de una carga. Tres copias del mismo mensaje
// terminan diciendo cosas distintas sobre el mismo número, así que se EXTRAJO (los textos son los de
// siempre, palabra por palabra) y las tres pantallas lo importan.
//
// Devuelve QUÉ hacer, no lo hace: si `km` viene, la pantalla lo pre-llena; `mensaje` es lo que se le
// dice a la persona. Las reglas de cuándo un número se ofrece o no son del servidor
// (/api/mantenimiento/leer-odometro → elegirOdometro): aquí solo se traducen a una frase.

import { cabecerasErp } from "@/lib/fetch-erp";

export type ResultadoLecturaIA = {
  /** El km que se puede pre-llenar, o null si no se debe pre-llenar ninguno. */
  km: number | null;
  mensaje: string;
};

export function fileToAdjunto(file: File): Promise<{ tipo: "image"; media_type: string; data: string }> {
  return new Promise((resolve, reject) => {
    if (file.size > 20 * 1024 * 1024) return reject(new Error("La foto supera 20 MB"));
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      return reject(new Error("Formato no soportado (usa JPG, PNG o WEBP)"));
    }
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || "");
      resolve({ tipo: "image", media_type: file.type || "image/jpeg", data: res.includes(",") ? res.split(",")[1] : res });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const fmt = (n: unknown) => Number(n).toLocaleString("es-PE");

/**
 * Lee el km de la foto. Con el vehículo, el servidor aplica la guía de ESE tablero y valida el
 * número contra su km (evita que entre el parcial o un dígito de más). Lanza si no se pudo leer.
 */
export async function leerOdometroDeFoto(
  foto: File,
  opts: { vehiculoId: number | null; flota: "propia" | "tercero" },
): Promise<ResultadoLecturaIA> {
  const adj = await fileToAdjunto(foto);
  const res = await fetch("/api/mantenimiento/leer-odometro", {
    method: "POST", headers: await cabecerasErp(),
    body: JSON.stringify({ adjunto: adj, vehiculo_id: opts.vehiculoId, flota: opts.flota }),
  });
  const raw = await res.text();
  let data: {
    ok?: boolean; error?: string; km?: number | null; km_ia?: number | null; auto_ok?: boolean;
    codigo_seleccion?: string; motivo_seleccion?: string; corregido?: boolean; confianza?: string;
  };
  try { data = JSON.parse(raw); }
  catch {
    if (res.status === 504 || /timeout|FUNCTION_INVOCATION/i.test(raw))
      throw new Error("El servidor tardó demasiado leyendo la foto. Intenta de nuevo con una imagen más nítida.");
    throw new Error(`El servidor respondió ${res.status}. ${raw.slice(0, 140)}`);
  }
  if (!res.ok || !data.ok) throw new Error(data?.error || `Error ${res.status}`);

  if (!data.km) return { km: null, mensaje: "La IA no pudo leer el km con seguridad. Ingrésalo manualmente." };

  if (data.auto_ok === false) {
    // No se pre-llena: el número no cuadra con el kilometraje de esta unidad. El titular sale del
    // CÓDIGO, no de olfatear el motivo: un dígito de más se arregla mirando la foto cifra por cifra.
    const titular = data.codigo_seleccion === "digito_de_mas"
      ? `A la lectura de la IA (${fmt(data.km)}) le SOBRA UN DÍGITO para esta unidad`
      : `El número leído (${fmt(data.km)}) no cuadra con el kilometraje de esta unidad`;
    return { km: null, mensaje: `${titular}${data.motivo_seleccion ? `:\n${data.motivo_seleccion}` : "."}\nRevisa la foto e ingrésalo a mano.` };
  }

  return {
    km: Number(data.km),
    mensaje: data.codigo_seleccion === "digito_repetido"
      // El número no lo transcribió el modelo: lo dedujo el ERP. Se pre-llena porque la persona
      // tiene la foto delante en este mismo momento —cotejarlo cuesta diez segundos—, pero se
      // dicen los DOS números para que pueda hacerlo.
      ? `La IA leyó ${fmt(data.km_ia)} y le sobra un dígito repetido.\n` +
        `Se propone ${fmt(data.km)} km, el único valor posible para esta unidad.\n\n` +
        `COMPRUÉBALO CONTRA LA FOTO antes de registrar: lo dedujo el sistema, no lo leyó nadie.`
      : data.codigo_seleccion === "decimal_como_entero"
        ? `Leído: ${fmt(data.km)} km.\nEl último tambor del odómetro es de DÉCIMAS: la IA lo había sumado como una cifra más (${fmt(data.km_ia)}) y se quitó. Revisa antes de registrar.`
      : data.corregido
        ? `Leído: ${fmt(data.km)} km.\nLa foto mostraba dos contadores: se tomó el total y se descartó el parcial. Revisa antes de registrar.`
        : `Leído: ${fmt(data.km)} km (confianza ${data.confianza}). Revisa antes de registrar.`,
  };
}
