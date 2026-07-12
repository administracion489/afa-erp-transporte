// lib/radar/prompts.ts — Prompts del pipeline Radar IA (SOLO servidor: los consume lib/radar/motor.ts).
//
// Tres familias de prompts, siguiendo el estilo prescriptivo de lib/vision-ia.ts
// ("Devuelve SOLO un JSON válido con EXACTAMENTE esta forma…"):
//   1) promptTriage()          — clasifica un mensaje de grupo de WhatsApp en una CategoriaRadar.
//   2) promptExtraccion()      — extrae datos estructurados según la categoría (formas de tipos.ts).
//   3) promptExtraccionMedia() — clasifica + extrae en UNA sola llamada para imágenes/PDF
//                                (vouchers de grifo, comprobantes, documentos escaneados).
// Este archivo solo construye strings: no toca BD ni secretos.

import type { CategoriaRadar } from "./tipos";

// ── Contexto que el motor pasa a cada prompt ─────────────────────────────────

export type ContextoPrompt = {
  grupo?: string | null;       // nombre del grupo de WhatsApp
  remitente?: string | null;   // nombre (pushName) o número del autor
  fechaHoy: string;            // YYYY-MM-DD hora Lima (UTC-5)
  horaAhora: string;           // HH:MM hora Lima
  palabrasClave?: string[];    // pistas extra configuradas en radar_config.palabras_clave
  contextoGrupo?: string | null; // nota del operador sobre qué es este grupo (radar_grupos.contexto)
};

// ── Helpers de fecha (solo formateo, la fecha Lima llega ya resuelta) ────────

function sumarDias(fechaISO: string, dias: number): string {
  const t = new Date(fechaISO + "T00:00:00Z").getTime() + dias * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function diaSemana(fechaISO: string): string {
  try {
    return new Date(fechaISO + "T00:00:00Z").toLocaleDateString("es-PE", { weekday: "long", timeZone: "UTC" });
  } catch {
    return "";
  }
}

function lineaContexto(ctx: ContextoPrompt): string {
  const manana = sumarDias(ctx.fechaHoy, 1);
  const pasado = sumarDias(ctx.fechaHoy, 2);
  const partes: string[] = [];
  if (ctx.grupo) partes.push(`Mensaje del grupo de WhatsApp "${ctx.grupo}"`);
  else partes.push("Mensaje de un grupo de WhatsApp de la operación");
  if (ctx.remitente) partes.push(`enviado por "${ctx.remitente}"`);
  const contextoGrupo = (ctx.contextoGrupo ?? "").trim();
  const lineaGrupo = contextoGrupo
    ? `\n\nIMPORTANTE — contexto de este grupo (lo definió el operador de AFA Transportes, tiene prioridad sobre cualquier suposición tuya): ${contextoGrupo}`
    : "";
  return `${partes.join(" ")}.
Hoy es ${diaSemana(ctx.fechaHoy)} ${ctx.fechaHoy} y son las ${ctx.horaAhora} en Lima, Perú (UTC-5).
Resolución de fechas relativas (hora Lima): "hoy" = ${ctx.fechaHoy} · "mañana"/"mñn" = ${manana} · "pasado mañana" = ${pasado}.${lineaGrupo}`;
}

function lineaPalabrasClave(ctx: ContextoPrompt): string {
  const palabras = (ctx.palabrasClave ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (!palabras.length) return "";
  return `\nPistas configuradas por el operador (términos que suelen indicar mensajes relevantes): ${palabras.join(", ")}.`;
}

// ── Glosario compartido (jerga peruana de los grupos de transporte) ──────────

const GLOSARIO = `Jerga frecuente en estos grupos (español peruano informal):
- "mñn" = mañana · "urg"/"urgente" = prioridad alta · "xfa"/"porfa" = por favor · "pax" = pasajeros.
- "bus 45" / "unidad 45" / "el 45" = referencia informal a una unidad de la flota (va en "unidad", NO es placa).
- "van", "sprinter", "custer"/"coaster", "h1", "minibús", "bus" = tipos de vehículo.
- "full day" = servicio de día completo · "ida y vuelta" = ida y retorno · "solo retorno" = solo el tramo de regreso.
- "recojo" = punto/hora de recogida · "traslado" = servicio puntual de transporte · "aeropuerto" = traslado aeropuerto.
- "grifo" = estación de servicio · "tanqueó"/"echó combustible" = recarga · "S/" = soles peruanos.
- "SOAT", "CITV"/"revisión técnica", "MTC", "SUTRAN" = documentos habilitantes del transporte en Perú.`;

// ── Descripciones de categorías (compartidas por triage y media) ─────────────

const DESCRIPCION_CATEGORIAS = `- "oportunidad_comercial": alguien pide o consulta un servicio de transporte que AFA Transportes podría cubrir con su flota (cotización, disponibilidad, "¿tienen van para mñn?", full day, traslado, recojo de personal). Incluye pedidos de apoyo/subcontrato de otro transportista SI implican que AFA cubra el servicio con su propia flota.
- "combustible": recarga de combustible o voucher de grifo DE UNA UNIDAD DE LA FLOTA DE AFA (propia o tercerizada bajo contrato con AFA) — galones, litros, diésel, GNV, GLP, urea, precio, importe. No es de la flota de AFA si no hay ninguna señal de que la unidad/conductor pertenece a la operación de AFA.
- "mantenimiento": trabajos de taller o mecánica sobre una unidad DE LA FLOTA DE AFA (cambio de aceite, frenos, llantas, repuestos, "la unidad está en el mecánico", scanner, soldadura).
- "operaciones": novedades de un servicio QUE AFA ESTÁ OPERANDO ese día con su propia flota o la tercerizada bajo contrato ("ya salí", "iniciando ruta", "llegué al punto", "pasajeros abordados", "terminé el servicio", retrasos, cancelaciones).
- "incidencias": choques, averías en ruta, robos, reclamos de clientes, accidentes, unidad varada — DE LA OPERACIÓN DE AFA.
- "documentacion": vencimiento o renovación de SOAT, revisión técnica (CITV), licencias de conducir, pólizas, permisos MTC/SUTRAN — de personal o unidades de AFA.
- "cobranza": pagos de clientes, facturas, depósitos, transferencias, "ya abonó", deudas por cobrar — de clientes de AFA.
- "otros": saludos, stickers, cadenas, humor, conversación personal o sin valor operativo. TAMBIÉN va aquí cualquier reporte de combustible/mantenimiento/operaciones/incidencia sobre un vehículo o servicio que NO es de AFA (p.ej. otro transportista contando su propio viaje, su propia unidad o su propio abastecimiento).

MUY IMPORTANTE: muchos grupos de WhatsApp del rubro transporte son redes de apoyo ENTRE transportistas/colegas independientes (se avisan entre ellos disponibilidad, pasajeros, viajes de terceros — nada que ver con AFA). Un mensaje de ese tipo de grupo casi siempre es "otros", salvo que alguien pida explícitamente un servicio que AFA podría cubrir (ahí sí es "oportunidad_comercial"). NUNCA clasifiques como "combustible", "mantenimiento", "operaciones" o "incidencias" el reporte de un vehículo o servicio ajeno a AFA solo porque el mensaje "suena" a eso — esas categorías son EXCLUSIVAS de la operación de AFA Transportes.`;

// ── Reglas comunes de extracción ─────────────────────────────────────────────

const REGLAS_EXTRACCION = `Reglas (no negociables):
- Si un dato no está, usa null. No inventes valores.
- Resuelve TODA fecha relativa ("hoy", "mañana", "el viernes") a una fecha absoluta YYYY-MM-DD de Lima usando el contexto de arriba.
- Horas en formato 24 horas "HH:MM".
- Placas en MAYÚSCULAS con guion, formato AAA-123 (ej. "abc123" o "ABC 123" → "ABC-123"). Si solo mencionan la unidad de forma informal ("bus 45"), ponlo en "unidad" y deja "placa" en null.
- Montos y cantidades como número puro (sin "S/", sin comas de miles).`;

// ── Formas JSON por categoría (espejo campo a campo de lib/radar/tipos.ts) ───

const FORMA_OPORTUNIDAD = `{
  "fecha": "YYYY-MM-DD"|null,           // fecha del servicio YA RESUELTA a fecha absoluta Lima
  "hora": "HH:MM"|null,                 // hora del servicio, 24h
  "ciudad": string|null,
  "distrito": string|null,
  "origen": string|null,                // punto de partida
  "destino": string|null,               // punto de llegada
  "pasajeros": number|null,             // cantidad de pasajeros (pax)
  "tipo_vehiculo": "AUTO"|"SUV"|"VAN"|"MINIBUS"|"BUS"|"CUSTER"|null,  // mapea "sprinter"/"h1"→"VAN", "coaster"/"custer"→"CUSTER"
  "unidades": number|null,              // cuántos vehículos piden
  "tiempo_espera": string|null,         // ej "3 horas de espera"
  "servicios_adicionales": string|null, // guía, peajes, alimentación, etc.
  "cliente": string|null,               // nombre de la persona que pide
  "empresa": string|null,               // empresa/institución si se menciona
  "telefono": string|null,              // teléfono de contacto si aparece en el texto
  "observaciones": string|null          // cualquier detalle relevante adicional
}`;

const FORMA_COMBUSTIBLE = `{
  "placa": string|null,                 // normalizada AAA-123 en MAYÚSCULAS
  "unidad": string|null,                // referencia informal ("bus 45") si no hay placa
  "fecha": "YYYY-MM-DD"|null,           // fecha de la recarga (del voucher si la hay)
  "hora": "HH:MM"|null,
  "grifo": string|null,                 // nombre del grifo/estación (ej "Primax", "Repsol")
  "direccion_grifo": string|null,       // dirección impresa en el voucher
  "tipo_combustible": "diesel"|"gasolina"|"glp"|"gnv"|"urea"|"biodiesel"|null,
  "galones": number|null,
  "litros": number|null,                // solo si el voucher está en litros
  "precio_galon": number|null,
  "precio_litro": number|null,
  "monto_total": number|null,           // importe total en soles
  "comprobante": string|null,           // serie-correlativo de la boleta/factura (ej "B001-004521")
  "kilometraje": number|null,           // odómetro si lo reportan
  "conductor": string|null,             // nombre del conductor
  "proveedor": string|null              // razón social de la empresa proveedora del voucher
}`;

const FORMA_MANTENIMIENTO = `{
  "placa": string|null,                 // normalizada AAA-123
  "unidad": string|null,                // referencia informal si no hay placa
  "tipo_trabajo": "aceite"|"neumaticos"|"frenos"|"reparacion"|"soat"|"revision_tecnica"|"otro"|null,
  "tipo": "preventivo"|"correctivo"|null,
  "descripcion": string|null,           // qué trabajo se hizo o se necesita
  "taller": string|null,                // taller/mecánico mencionado
  "costo": number|null,                 // en soles
  "fecha": "YYYY-MM-DD"|null,
  "urgente": boolean|null               // true SOLO si la unidad no puede operar
}`;

const FORMA_OPERACION = `{
  "placa": string|null,                 // normalizada AAA-123
  "unidad": string|null,
  "evento": "llego"|"inicio"|"finalizo"|"abordo"|"retraso"|"cancelacion"|"otro"|null,
  // "inicio" = arrancó el servicio/salió a ruta · "finalizo" = terminó el servicio ·
  // "llego" = llegó a un punto · "abordo" = pasajeros abordados · "retraso" = demora ·
  // "cancelacion" = el servicio se cancela.
  "detalle": string|null,               // resumen de la novedad
  "hora": "HH:MM"|null                  // hora reportada del evento
}`;

const FORMA_DOCUMENTACION = `{
  "tipo_documento": string|null,        // "SOAT" | "Licencia" | "Revisión Técnica (CITV)" | "Póliza" | "Permiso" | otro
  "placa": string|null,                 // normalizada AAA-123 si el documento es de un vehículo
  "conductor": string|null,             // nombre si el documento es de una persona (licencia)
  "fecha_vencimiento": "YYYY-MM-DD"|null,
  "detalle": string|null
}`;

const FORMA_INCIDENCIA = `{
  "placa": string|null,                 // normalizada AAA-123
  "unidad": string|null,
  "tipo_incidencia": "choque"|"averia"|"robo"|"reclamo"|"accidente"|"otro"|null,
  "gravedad": "alta"|"media"|"baja"|null,  // "alta" = hay heridos, unidad inoperativa o pérdida grave
  "detalle": string|null
}`;

const FORMA_COBRANZA = `{
  "cliente": string|null,               // nombre de la persona
  "empresa": string|null,               // empresa que paga o debe
  "monto": number|null,                 // en soles
  "factura": string|null,               // número de factura/comprobante si se menciona
  "detalle": string|null
}`;

const FORMAS: Record<Exclude<CategoriaRadar, "otros">, string> = {
  oportunidad_comercial: FORMA_OPORTUNIDAD,
  combustible: FORMA_COMBUSTIBLE,
  mantenimiento: FORMA_MANTENIMIENTO,
  operaciones: FORMA_OPERACION,
  incidencias: FORMA_INCIDENCIA,
  documentacion: FORMA_DOCUMENTACION,
  cobranza: FORMA_COBRANZA,
};

// Encabezado por categoría para el prompt de extracción.
const ENCABEZADO_EXTRACCION: Record<Exclude<CategoriaRadar, "otros">, string> = {
  oportunidad_comercial:
    "El mensaje es una OPORTUNIDAD COMERCIAL: alguien pide o consulta un servicio de transporte. Extrae los datos del pedido para que el área comercial pueda cotizar.",
  combustible:
    "El mensaje reporta una RECARGA DE COMBUSTIBLE de una unidad de LA FLOTA DE AFA (texto o datos dictados de un voucher de grifo). Extrae los datos de la recarga.",
  mantenimiento:
    "El mensaje reporta un trabajo de MANTENIMIENTO o mecánica sobre una unidad de LA FLOTA DE AFA. Extrae los datos del trabajo.",
  operaciones:
    "El mensaje es una novedad de OPERACIONES sobre un servicio del día QUE AFA ESTÁ OPERANDO (inicio, fin, llegada, abordaje, retraso o cancelación). Extrae el evento.",
  incidencias:
    "El mensaje reporta una INCIDENCIA (choque, avería, robo, reclamo o accidente) DE LA OPERACIÓN DE AFA. Extrae los datos del hecho.",
  documentacion:
    "El mensaje habla de DOCUMENTACIÓN habilitante (SOAT, CITV, licencias, pólizas, permisos) y posiblemente de su vencimiento. Extrae los datos del documento.",
  cobranza:
    "El mensaje habla de COBRANZA o pagos de clientes (facturas, depósitos, deudas). Extrae los datos del pago o la deuda.",
};

// ── 1) TRIAGE ────────────────────────────────────────────────────────────────

/** Prompt de clasificación de un mensaje de texto en una CategoriaRadar. */
export function promptTriage(ctx: ContextoPrompt): string {
  return `Eres el analista del Radar IA de AFA Transportes (operador de transporte de personal y turismo en Perú). Tu trabajo es clasificar mensajes de los grupos de WhatsApp de la operación para que el ERP actúe sobre los relevantes.

${lineaContexto(ctx)}${lineaPalabrasClave(ctx)}

${GLOSARIO}

Clasifica el mensaje en UNA de estas categorías:
${DESCRIPCION_CATEGORIAS}

Devuelve SOLO un JSON válido con EXACTAMENTE esta forma (sin texto adicional, sin markdown):
{
  "categoria": "oportunidad_comercial"|"combustible"|"mantenimiento"|"operaciones"|"incidencias"|"documentacion"|"cobranza"|"otros",
  "confianza": number,   // 0..1, qué tan seguro estás de la categoría
  "resumen": string      // UNA sola línea en español que resuma el mensaje
}

En caso de duda entre una categoría útil y "otros", elige la categoría útil con confianza baja; usa "otros" solo cuando el mensaje claramente no aporta a la operación. Responde únicamente el JSON.`;
}

// ── 2) EXTRACCIÓN por categoría ──────────────────────────────────────────────

/** Prompt de extracción estructurada para una categoría ya clasificada (≠ "otros"). */
export function promptExtraccion(categoria: CategoriaRadar, ctx: ContextoPrompt): string {
  if (categoria === "otros") {
    // Defensivo: el motor nunca debería pedir extracción de "otros".
    return `${lineaContexto(ctx)}\n\nDevuelve SOLO un JSON válido: {}. Responde únicamente el JSON.`;
  }
  const extra =
    categoria === "combustible"
      ? `\n- Si el texto transcribe un voucher, captura TODOS los campos impresos que se mencionen (grifo, dirección, comprobante, cantidad, precio, total, fecha y hora).`
      : "";
  return `Eres el analista del Radar IA de AFA Transportes (operador de transporte de personal y turismo en Perú).

${lineaContexto(ctx)}

${GLOSARIO}

${ENCABEZADO_EXTRACCION[categoria]}

${REGLAS_EXTRACCION}${extra}

Devuelve SOLO un JSON válido con EXACTAMENTE esta forma (sin texto adicional, sin markdown):
${FORMAS[categoria]}

Responde únicamente el JSON.`;
}

// ── 3) EXTRACCIÓN de media (imagen/PDF): clasifica + extrae en una llamada ───

/** Prompt combinado para mensajes con imagen o PDF (vouchers, documentos, capturas). */
export function promptExtraccionMedia(ctx: ContextoPrompt): string {
  return `Eres el analista del Radar IA de AFA Transportes (operador de transporte de personal y turismo en Perú). Te entrego una imagen o PDF compartido en un grupo de WhatsApp de la operación (puede venir acompañado de un texto/caption).

${lineaContexto(ctx)}${lineaPalabrasClave(ctx)}

${GLOSARIO}

Haz DOS cosas en una sola respuesta:

1) CLASIFICA el contenido en UNA de estas categorías:
${DESCRIPCION_CATEGORIAS}

2) EXTRAE los datos según la categoría elegida. La forma de "datos" depende de la categoría:
- "oportunidad_comercial" → ${FORMA_OPORTUNIDAD}
- "combustible" → ${FORMA_COMBUSTIBLE}
- "mantenimiento" → ${FORMA_MANTENIMIENTO}
- "operaciones" → ${FORMA_OPERACION}
- "incidencias" → ${FORMA_INCIDENCIA}
- "documentacion" → ${FORMA_DOCUMENTACION}
- "cobranza" → ${FORMA_COBRANZA}
- "otros" → {}

Caso especial: si la imagen es la FOTO DE UN VOUCHER O COMPROBANTE DE GRIFO (categoría "combustible"), lee TODOS los campos impresos: nombre del grifo, dirección de la estación, razón social del proveedor, número de comprobante (serie-correlativo, ej "B001-004521"), galones o litros despachados, precio unitario, importe total, fecha y hora de la venta, y la placa si aparece.

${REGLAS_EXTRACCION}

Devuelve SOLO un JSON válido con EXACTAMENTE esta forma (sin texto adicional, sin markdown):
{
  "categoria": "oportunidad_comercial"|"combustible"|"mantenimiento"|"operaciones"|"incidencias"|"documentacion"|"cobranza"|"otros",
  "confianza": number,   // 0..1
  "resumen": string,     // UNA sola línea en español
  "datos": { … }         // la forma correspondiente a la categoría; {} si es "otros"
}

Responde únicamente el JSON.`;
}
