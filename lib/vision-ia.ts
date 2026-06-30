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
Devuelve SOLO un JSON: {"km": number, "confianza": "alta"|"media"|"baja", "texto_leido": string}.
"km" es el kilometraje TOTAL del vehículo (entero, ignora el cuentakilómetros parcial/trip y los decimales). Si no puedes leerlo con seguridad, devuelve km=0 y confianza="baja". Responde únicamente el JSON.`;

export async function extraerOdometro(
  adjunto: Adjunto
): Promise<{ km: number; confianza: string; texto_leido: string }> {
  const reqOdo: any = {
    model: MODELO_VISION,
    max_tokens: 300,
    messages: [{ role: "user", content: [{ type: "text", text: PROMPT_ODO }, bloqueAdjunto(adjunto)] }],
  };
  const resp: any = await getAnthropic().messages.create(reqOdo);
  const r = extraerJSON(textoDe(resp));
  return {
    km: Math.round(Number(r.km || 0)),
    confianza: r.confianza || "baja",
    texto_leido: r.texto_leido || "",
  };
}
