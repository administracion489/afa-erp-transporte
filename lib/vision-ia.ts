// lib/vision-ia.ts
// Visión con Claude para mantenimiento:
//   1) extraerPlanFabricante() — lee la foto/PDF del plan del fabricante
//      (matriz tarea × km) y devuelve un plan estructurado para revisión humana.
//   2) extraerOdometro() — lee la foto del odómetro y devuelve el km.
// Reusa el patrón de lib/crm-ia.ts (SDK Anthropic, ANTHROPIC_API_KEY del entorno).

import Anthropic from "@anthropic-ai/sdk";

// Cliente perezoso. Si ANTHROPIC_API_KEY no está configurada, NO debe reventar al
// cargar el módulo: eso haría que el route devuelva un 500 SIN JSON (antes del
// try/catch), y el cliente vería "Unexpected token ... is not valid JSON".
// Al crearlo dentro de la función, el error sale limpio como { ok:false, error }.
let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Falta ANTHROPIC_API_KEY en el servidor. Configúrala en Vercel → Settings → Environment Variables y vuelve a desplegar."
    );
  }
  return (_anthropic ??= new Anthropic());
}
const MODELO_VISION = "claude-opus-4-8";

export type Adjunto = {
  tipo: "image" | "pdf";
  media_type: string;   // image/jpeg | image/png | image/webp | application/pdf
  data: string;         // base64 SIN el prefijo data:...;base64,
};

const IMG_VALIDOS = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function bloqueAdjunto(a: Adjunto): any {
  if (a.tipo === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } };
  }
  const mt = IMG_VALIDOS.includes(a.media_type) ? a.media_type : "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mt, data: a.data } };
}

function extraerJSON(texto: string): any {
  const limpio = texto.replace(/```json/gi, "").replace(/```/g, "").replace(/^`+|`+$/g, "").trim();
  const ini = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (ini === -1 || fin === -1) {
    throw new Error("La IA no devolvió un JSON reconocible (respuesta vacía o truncada)");
  }
  const frag = limpio.slice(ini, fin + 1);
  try {
    return JSON.parse(frag);
  } catch (e: any) {
    throw new Error(`No se pudo interpretar el JSON de la IA: ${e.message}. Inicio: ${frag.slice(0, 120)}`);
  }
}

function textoDe(resp: any): string {
  return (resp?.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

// ─── PLAN DEL FABRICANTE ──────────────────────────────────────────────────────

const PROMPT_PLAN = `Eres un experto en mantenimiento vehicular. Te entrego la imagen o PDF de un PLAN DE MANTENIMIENTO PREVENTIVO de un fabricante: una matriz donde las FILAS son tareas/insumos y las COLUMNAS son hitos de kilometraje, y cada celda marca la acción.

Convención de acciones: C = Cambio · I = Inspección (y de ser necesario, cambio) · R = Realizar en cada servicio.

Devuelve SOLO un JSON válido con EXACTAMENTE esta forma (sin texto adicional, sin markdown):
{
  "marca": string,
  "modelo": string,
  "motor": string|null,
  "intervalo_base_km": number|null,    // cada cuántos km se hace un servicio (la columna de km más pequeña, ej 5000)
  "intervalo_base_meses": number|null, // si el documento dice "cada 6 meses" → 6
  "tareas": [
    {
      "tarea": string,                 // ej "Aceite Motor"
      "especificacion": string|null,   // ej viscosidad/norma si aparece
      "categoria": string|null,        // Fluidos | Repuestos | Inspección | Otros
      "cantidad": number|null,
      "unidad": string|null,
      "acciones": [ {"km": number, "accion": "C"|"I"|"R"} ]  // una entrada por cada celda marcada en esa fila
    }
  ]
}

Incluye TODAS las filas de tareas y TODAS las columnas de km que se vean. Si un dato no está, usa null. No inventes valores. Responde únicamente el JSON.`;

export async function extraerPlanFabricante(adjuntos: Adjunto[]): Promise<any> {
  const content: any[] = [{ type: "text", text: PROMPT_PLAN }, ...adjuntos.map(bloqueAdjunto)];
  // Streaming: la salida puede ser larga (hasta 16k tokens). Mantiene viva la
  // conexión mientras el modelo genera y evita timeouts de petición.
  const stream = getAnthropic().messages.stream({
    model: MODELO_VISION, max_tokens: 16000, messages: [{ role: "user", content }],
  } as any);
  const resp: any = await stream.finalMessage();
  const plan = extraerJSON(textoDe(resp));

  // Normalización: derivar km_intervalo / cada_servicio por tarea para el cálculo de vencimientos.
  for (const t of (plan.tareas || [])) {
    const acc = Array.isArray(t.acciones) ? t.acciones : [];
    const cambios = acc
      .filter((a: any) => a.accion === "C" && Number.isFinite(Number(a.km)))
      .map((a: any) => Number(a.km))
      .sort((x: number, y: number) => x - y);
    t.cada_servicio = acc.some((a: any) => a.accion === "R");
    t.km_intervalo = cambios.length >= 2 ? cambios[1] - cambios[0] : (cambios[0] || null);
  }
  return plan;
}

// ─── ODÓMETRO ─────────────────────────────────────────────────────────────────

const PROMPT_ODO = `Te paso la foto del ODÓMETRO (cuentakilómetros) del tablero de un vehículo.
Devuelve SOLO un JSON:
{"km": number, "trip_km": number|null, "confianza": "alta"|"media"|"baja", "calidad_imagen": "buena"|"regular"|"mala", "motivo": string, "texto_leido": string}.
"km" es el kilometraje TOTAL del vehículo, en kilómetros ENTEROS.
"trip_km" es el cuentakilómetros PARCIAL/trip. Si la pantalla muestra DOS contadores de km, este campo NUNCA debe ser null: pon aquí el otro número que viste.
NI UN DÍGITO DE MÁS: cuenta los dígitos del odómetro y transcribe SOLO los de ese grupo, tal como están. Un dígito añadido al final multiplica el kilometraje por 10 (22744 convertido en 227447), y es el error más caro y más frecuente en esta flota. No arrastres al número un dígito vecino de la pantalla —el trip, el reloj, la temperatura, el nivel de combustible, la marcha, un icono— ni completes el número con lo que creas que falta. Si el total aparece con una décima separada por punto o coma, en "km" va solo la parte entera; si NO hay separador, todos los dígitos que ves son el total y no sobra ninguno.
ANTI-INVERSIÓN: en un mismo tablero el TOTAL es SIEMPRE el número MAYOR de kilómetros y el parcial el MENOR. Si el número que ibas a poner en "km" es MENOR que otro número de kilómetros de la pantalla, los estás intercambiando.
La temperatura ("28.0°C"), la hora ("20:25") y una tasa de consumo ("16.3 L/100km") NO son kilómetros.
"calidad_imagen"="mala" si la foto está borrosa, con reflejo/brillo que tape dígitos, muy oscura, o el odómetro no es legible; "regular" si se lee con algo de esfuerzo; "buena" si es nítida.
"motivo" = por qué esa confianza/calidad, en pocas palabras (ej "lectura nítida", "reflejo sobre el último dígito", "foto borrosa").
Si no puedes leerlo con seguridad devuelve km=0 y confianza="baja"; NUNCA inventes un número ni lo deduzcas de lo que creas que debería marcar. Responde únicamente el JSON.`;

/** Lo que el ERP ya sabe de ESTA unidad y ayuda a leer su tablero. */
export type ContextoLecturaOdometro = {
  lecciones?: string | null;
  guia?: string | null;      // vehiculos(_tercero).guia_odometro: dónde mirar en ESE tablero
  placa?: string | null;
  digitos?: number | null;   // cuántos dígitos tiene su odómetro (nunca el km exacto: sería copiable)
};

export async function extraerOdometro(
  adjunto: Adjunto,
  // string = solo las lecciones (firma vieja, retrocompatible).
  ctx?: string | null | ContextoLecturaOdometro
): Promise<{ km: number; kilometraje: number; trip_km: number | null; confianza: string; calidad_imagen: string; motivo: string; texto_leido: string }> {
  const c: ContextoLecturaOdometro = typeof ctx === "string" || ctx == null ? { lecciones: ctx ?? null } : ctx;

  const bloques: string[] = [PROMPT_ODO];
  if (c.guia?.trim()) {
    bloques.push(`Cómo leer el tablero de ESTA unidad${c.placa ? ` (${c.placa})` : ""}, según el operador de AFA: ${c.guia.trim()}`);
  }
  // La FORMA del número va SIEMPRE que se conozca, haya o no guía escrita: es la señal que
  // atrapa el error caro (un dígito de más → kilometraje ×10) y no es una cifra copiable.
  // Antes viajaba dentro del bloque de la guía, así que las unidades sin guía —la mayoría— se
  // quedaban sin ancla ninguna.
  if (c.digitos) {
    bloques.push(
      `En esta unidad${c.placa ? ` (${c.placa})` : ""} el odómetro TOTAL es un número de ${c.digitos} dígitos. ` +
        `Si lo que leíste tiene ${c.digitos + 1} dígitos, sobra uno: vuelve a la foto, cuenta los dígitos del odómetro uno por uno y comprueba de dónde salió el que añadiste.`
    );
  }
  if (c.lecciones?.trim()) {
    bloques.push(
      `ERRORES QUE YA COMETISTE en este mismo parque automotor (corregidos por el equipo). Revísalos y no los repitas:\n${c.lecciones.trim()}\nSi tu lectura se parece a alguno de esos casos, baja la confianza y explica por qué en "motivo".`
    );
  }

  const reqOdo: any = {
    model: MODELO_VISION,
    max_tokens: 300,
    messages: [{ role: "user", content: [{ type: "text", text: bloques.join("\n\n") }, bloqueAdjunto(adjunto)] }],
  };
  const resp: any = await getAnthropic().messages.create(reqOdo);
  const r = extraerJSON(textoDe(resp));
  const km = Math.round(Number(r.km || 0));
  const trip = r.trip_km != null && Number.isFinite(Number(r.trip_km)) ? Math.round(Number(r.trip_km)) : null;
  return {
    km,                              // alias retrocompatible (OdometroTab lee data.km)
    kilometraje: km,
    trip_km: trip,
    confianza: r.confianza || "baja",
    calidad_imagen: r.calidad_imagen || "regular",
    motivo: r.motivo || "",
    texto_leido: r.texto_leido || "",
  };
}
