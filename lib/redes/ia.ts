// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/ia.ts — SOLO SERVIDOR. El redactor de la propuesta diaria.
//
// LA REGLA QUE GOBIERNA ESTE ARCHIVO: **LA IA REDACTA, NO AFIRMA HECHOS.**
//
// Un texto de marketing generado sin datos suena bien inventando: «más de 5 000
// pasajeros al día», «15 años de experiencia», «cobertura en todo el país». Ninguna de
// esas frases la ha escrito nadie y todas se publican en nombre de la empresa. Un
// número falso en la cara pública de AFA no se puede despublicar de la memoria de quien
// lo leyó, y si el número aparece en una licitación es un problema mayor que el post.
//
// Por eso el prompt PROHÍBE cifras, años y superlativos comparativos, y por eso los
// datos que sí se pueden usar (a qué se dedica la empresa, a quién le habla) salen de
// `redes_config`, que es lo que TECLEÓ una persona. Es la misma decisión que
// `montoDe` con el falso flete: no se deduce una intención de un dato que nadie escribió.
//
// Y LA PROPUESTA NACE EN `propuesta`, NUNCA APROBADA. El motor no publica nada sin
// `aprobada`, y quien aprueba es una persona. Este módulo no tiene forma de saltárselo:
// no escribe ese estado en ningún sitio.
// ──────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { CAPACIDADES, type Red } from "./tipos";
import {
  MAX_ESCENAS,
  MAX_ESCENA_SEG,
  MAX_SUBTEXTO,
  MAX_TITULO,
  MIN_ESCENA_SEG,
  MOVIMIENTOS,
  TRANSICIONES,
  normalizarGuion,
  type CodigoGuion,
  type Guion,
} from "./guion";
import { empresaConDefectos } from "../empresa-perfil";

const anthropic = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Mismo criterio que `lib/crm-ia.ts`: Haiku no acepta effort ni thinking. */
function modelExtras(modelo: string): Record<string, unknown> {
  if (!modelo || modelo.startsWith("claude-haiku")) return {};
  return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
}

export type ConfigRedes = {
  activo: boolean;
  hora_propuesta_min: number;
  hora_publicar_min: number;
  tono: string | null;
  publico: string | null;
  prohibido: string | null;
  hashtags_fijos: string | null;
  temas: string[] | null;
  modelo: string | null;
};

export async function leerConfig(): Promise<ConfigRedes | null> {
  const sb = db();
  if (!sb) return null;
  const { data } = await sb.from("redes_config").select("*").eq("id", 1).maybeSingle();
  return (data as ConfigRedes) ?? null;
}

/**
 * El nombre que se estampa en el video, resuelto por `empresaConDefectos`.
 *
 * NO es una constante con «AFA Transportes» dentro, que es lo que había: **este ERP se
 * vende**, y un literal en el código sale impreso en el video de quien lo compre — el
 * mismo defecto que los PDF de mantenimiento y que el respaldo de `empresa-perfil`.
 * Con el perfil sin llenar devuelve `null` y el video sale SIN marca: mejor sin nombre
 * que con el de otra empresa, igual que la autorización del MTC.
 */
export async function marcaDeEmpresa(): Promise<string | null> {
  const sb = db();
  if (!sb) return null;
  const { data } = await sb.from("empresa_perfil").select("nombre, razon_social").eq("id", 1).maybeSingle();
  const e = empresaConDefectos(data as any);
  return e.sinConfigurar ? null : e.nombre;
}

/**
 * El tema del día. Rota por el día del año sobre la lista configurada, no al azar:
 * con `random` el mismo tema puede salir tres días seguidos y el canal se ve repetido
 * justo la semana que alguien lo está mirando.
 */
function temaDelDia(temas: string[] | null, fecha: string): string | null {
  const lista = (temas ?? []).filter((t) => t.trim());
  if (!lista.length) return null;
  const dias = Math.floor(new Date(`${fecha}T12:00:00Z`).getTime() / 86_400_000);
  return lista[dias % lista.length];
}

// El tope más ESTRECHO de las redes que se van a usar manda sobre el texto. Redactar a
// 2 200 y que Instagram lo rechace es descubrir el problema cuando ya no hay tiempo de
// arreglarlo; redactar corto entra en todas. El estado de WhatsApp (700) es el más
// estrecho de todos, y es el que de verdad acota.
function topeTexto(redes: Red[]): number {
  const topes = redes.map((r) => CAPACIDADES[r].maxTexto).filter((n) => n > 0);
  return topes.length ? Math.min(...topes) : 700;
}

function sistema(cfg: ConfigRedes, redes: Red[]): string {
  const tope = topeTexto(redes);
  return [
    "Redactas las publicaciones diarias de redes sociales de una empresa de transporte de",
    "personal en Perú. Escribes en español de Perú, en un castellano natural y directo.",
    "",
    "LO QUE NO PUEDES HACER, Y ES LO MÁS IMPORTANTE DE ESTAS INSTRUCCIONES:",
    "• NO inventes NINGÚN dato: ni cifras, ni años de experiencia, ni número de unidades,",
    "  ni cantidad de clientes, ni certificaciones, ni premios, ni porcentajes.",
    "  Si no está escrito más abajo, NO EXISTE y no se menciona.",
    "• NO nombres clientes, placas, conductores, rutas concretas, precios ni tarifas.",
    "• NO uses superlativos comparativos ('los mejores', 'líderes del mercado', 'los más",
    "  seguros'): son afirmaciones sobre la competencia que nadie ha verificado.",
    "• NO prometas nada que no se pueda cumplir ('siempre puntuales', 'cero incidentes').",
    "Un dato inventado aquí se publica en nombre de la empresa y no se puede retirar.",
    "Prefiere SIEMPRE un texto más corto y vago antes que uno concreto e inventado.",
    "",
    `LARGO: el texto completo debe caber en ${tope} caracteres. Apunta a la mitad: los`,
    "textos cortos funcionan mejor y el mismo texto se publica en varias redes.",
    "",
    cfg.tono ? `TONO DE LA MARCA:\n${cfg.tono}` : "TONO: cercano, profesional, sin jerga corporativa.",
    "",
    cfg.publico ? `A QUIÉN LE HABLA:\n${cfg.publico}` : "",
    cfg.prohibido ? `\nPROHIBIDO EXPRESAMENTE POR LA EMPRESA:\n${cfg.prohibido}` : "",
    cfg.hashtags_fijos ? `\nHASHTAGS QUE SIEMPRE VAN AL FINAL:\n${cfg.hashtags_fijos}` : "",
    "",
    "FORMATO DE RESPUESTA — responde SOLO con un objeto JSON, sin ```, sin explicación:",
    '{"texto": "...", "titulo": "...", "tema": "..."}',
    "• texto: la publicación completa, con sus saltos de línea y sus hashtags al final.",
    "• titulo: máximo 100 caracteres, para YouTube. Descriptivo, sin hashtags ni emojis.",
    "• tema: dos o tres palabras que resuman de qué va, para el historial.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type PropuestaIA = {
  ok: boolean;
  texto?: string;
  titulo?: string;
  tema?: string;
  modelo?: string;
  error?: string;
};

/**
 * Le pide a Claude el texto del día.
 *
 * No escribe nada en la base: solo devuelve el texto. Quien lo guarda es
 * `proponerPublicacion`, y separarlo es lo que permite el botón «Proponer otro» de la
 * pantalla sin crear una fila por cada intento.
 */
export async function redactarPublicacion(opts: {
  fecha: string;
  redes: Red[];
  cfg: ConfigRedes;
  /** Lo que pidió el operador esta vez. Manda sobre el tema rotado. */
  instruccion?: string;
  /** Lo publicado los últimos días, para no repetirse. */
  recientes?: string[];
}): Promise<PropuestaIA> {
  const { fecha, redes, cfg, instruccion, recientes } = opts;
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "Falta ANTHROPIC_API_KEY en el entorno." };
  }

  const modelo = cfg.modelo || "claude-opus-5";
  const tema = instruccion?.trim() || temaDelDia(cfg.temas, fecha);

  const partes = [
    `Redacta la publicación del ${fecha}.`,
    tema ? `Tema de hoy: ${tema}` : "Tema libre, dentro de lo que hace la empresa.",
    // Enseñarle lo reciente es lo único que evita que el canal diga lo mismo toda la
    // semana con otras palabras, que es el modo de fallo típico de esto.
    recientes?.length
      ? `\nNO repitas el enfoque ni las frases de lo publicado estos días:\n` +
        recientes.map((r, i) => `${i + 1}. ${r.slice(0, 300)}`).join("\n")
      : "",
  ].filter(Boolean);

  try {
    const resp: any = await anthropic.messages.create({
      model: modelo,
      max_tokens: 2000,
      system: sistema(cfg, redes),
      messages: [{ role: "user", content: partes.join("\n") }],
      ...modelExtras(modelo),
    } as any);

    const texto = (resp.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    const json = extraerJson(texto);
    if (!json?.texto) {
      return { ok: false, error: "El modelo no devolvió un texto utilizable." };
    }
    return {
      ok: true,
      texto: String(json.texto).trim(),
      titulo: json.titulo ? String(json.titulo).slice(0, 100) : undefined,
      tema: json.tema ? String(json.tema).slice(0, 80) : (tema ?? undefined),
      modelo,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Saca el objeto JSON de la respuesta.
 *
 * Se parsea con tolerancia a propósito: el modelo puede envolverlo en ```json, o
 * añadir una frase antes. Un fallo de parseo aquí no debe costar la propuesta del día,
 * así que se busca el primer `{` y el último `}` antes de rendirse. (Mismo criterio que
 * los otros módulos de IA del ERP, que parsean JSON del texto en vez de usar salidas
 * estructuradas: una sola forma de hacerlo en todo el repo.)
 */
function extraerJson(texto: string): any | null {
  const limpio = texto.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(limpio);
  } catch {
    /* sigue */
  }
  const a = limpio.indexOf("{");
  const b = limpio.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(limpio.slice(a, b + 1));
    } catch {
      /* sigue */
    }
  }
  return null;
}

// ── El guion del video ────────────────────────────────────────────────────────
//
// NINGÚN MODELO DE ANTHROPIC GENERA VIDEO NI IMAGEN, y eso hay que decirlo en vez de
// aparentarlo: lo que la IA aporta aquí es la DIRECCIÓN sobre las fotos que ya existen —
// qué se ve en cada escena, qué frase va encima, cuánto dura y cómo se mueve la cámara.
//
// Y LAS MIRA DE VERDAD. Las fotos van al modelo como imágenes, no como una lista de URLs:
// sin verlas, el guion sería el caption repartido en cuatro trozos y la escena diría
// «nuestras unidades» sobre la foto de una oficina. Es la diferencia entre un guion y un
// troceado. Se mandan por URL (el bucket es público, que es la razón de que lo sea) para
// no bajar y re-subir megabytes en cada propuesta.
//
// EL TEXTO DE PANTALLA NO ES EL CAPTION, y el prompt lo repite porque es el error natural
// del modelo: se le da el caption como contexto y la tentación es copiarlo. Cuatro a siete
// palabras por escena; el caption sigue en su sitio.

/** Cuántas fotos se le enseñan al modelo. Más allá, el guion no cabe en `MAX_ESCENAS`. */
const MAX_IMAGENES_GUION = 8;

function sistemaGuion(cfg: ConfigRedes, nImagenes: number, marca: string | null): string {
  return [
    "Diriges videos verticales cortos (Reel / Short / TikTok) para una empresa peruana de",
    "transporte de personal. Te dan el texto de la publicación del día y las fotos que hay.",
    "Tu trabajo es escribir el GUION: qué foto se ve en cada escena, qué frase va ENCIMA,",
    "cuánto dura y cómo se mueve la cámara.",
    "",
    "LO MÁS IMPORTANTE: EL TEXTO DE PANTALLA NO ES EL TEXTO DE LA PUBLICACIÓN.",
    "El caption se lee con el pulgar quieto; lo que va sobre el video se lee en dos segundos",
    `mientras la imagen se mueve. Cada 'titulo' son 3 a 7 palabras, máximo ${MAX_TITULO}`,
    "caracteres. NO copies frases enteras del caption, NO pongas hashtags, NO pongas emojis",
    "(en el video salen como cuadros vacíos) y NO repitas la misma idea en dos escenas.",
    "",
    "MIRA LAS FOTOS ANTES DE ESCRIBIR. La frase de una escena tiene que tener que ver con lo",
    "que se ve en SU foto. Si una foto no te dice nada que encaje, déjala fuera: es mejor un",
    "guion de tres escenas buenas que de cinco con una que no viene a cuento.",
    "",
    "LO QUE NO PUEDES HACER, y es lo mismo que rige el caption:",
    "• NO inventes NINGÚN dato: ni cifras, ni años, ni número de unidades, ni clientes, ni",
    "  certificaciones, ni porcentajes. Si no lo ves en la foto o no está escrito abajo, NO",
    "  EXISTE. Y lo que ves en una foto se describe, no se convierte en un dato ('buses' sí,",
    "  'nuestra flota de 40 buses' no).",
    "• NO nombres clientes, placas, conductores, rutas concretas, precios ni tarifas, aunque",
    "  se lean en la foto.",
    "• NO uses superlativos comparativos ni promesas ('los más seguros', 'siempre puntuales').",
    "",
    `HAY ${nImagenes} FOTO(S), numeradas de 0 a ${Math.max(0, nImagenes - 1)} en el orden en que`,
    "te llegan. El campo 'imagen' es ese número. Usa null solo para una tarjeta de color sin",
    "foto (sirve para rematar).",
    "",
    "RITMO:",
    `• Entre 3 y ${MAX_ESCENAS - 1} escenas, sin contar el cierre.`,
    `• Cada escena dura entre ${MIN_ESCENA_SEG} y ${MAX_ESCENA_SEG} segundos; lo normal son 2.5 a 3.5.`,
    "• La PRIMERA escena es el gancho: tiene que hacer parar el dedo. Nada de saludos.",
    "• La ÚLTIMA escena lleva \"tipo\": \"cierre\", imagen null y una frase de remate corta.",
    marca ? `  La marca que aparece en pantalla es «${marca}»; no hace falta repetirla en el texto.` : "",
    "",
    `• 'movimiento' es uno de: ${MOVIMIENTOS.join(", ")}. Elígelo según la foto: un plano`,
    "  abierto pide zoom_in, un vehículo de lado pide un paneo. No repitas el mismo dos veces",
    "  seguidas.",
    `• 'transicion' es cómo ENTRA la escena, uno de: ${TRANSICIONES.join(", ")}.`,
    `• 'texto' es una línea secundaria opcional, máximo ${MAX_SUBTEXTO} caracteres. Úsala poco.`,
    "",
    cfg.tono ? `TONO DE LA MARCA:\n${cfg.tono}` : "",
    cfg.publico ? `A QUIÉN LE HABLA:\n${cfg.publico}` : "",
    cfg.prohibido ? `PROHIBIDO EXPRESAMENTE POR LA EMPRESA:\n${cfg.prohibido}` : "",
    "",
    "FORMATO DE RESPUESTA — responde SOLO con un objeto JSON, sin ```, sin explicación:",
    '{"escenas":[{"imagen":0,"titulo":"...","texto":"...","movimiento":"zoom_in",',
    '"duracion_seg":3,"transicion":"corte"}, ... ,{"imagen":null,"titulo":"...",',
    '"movimiento":"estatico","duracion_seg":2.2,"transicion":"fundido","tipo":"cierre"}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

export type GuionIA = {
  ok: boolean;
  guion?: Guion;
  avisos?: CodigoGuion[];
  modelo?: string;
  error?: string;
};

/**
 * Le pide a Claude el guion del video del día.
 *
 * Devuelve el guion YA NORMALIZADO: lo que el modelo escriba pasa por `normalizarGuion`
 * antes de salir de aquí, así que ningún consumidor recibe una escena de 40 segundos ni
 * un índice de foto que no existe. Los arreglos viajan como `avisos` — corregir en
 * silencio sería que nadie sepa que se corrigió.
 */
export async function redactarGuion(opts: {
  texto: string;
  imagenes: string[];
  cfg: ConfigRedes;
  marca?: string | null;
  /** Lo que pidió el operador esta vez ("más corto", "empieza por el taller"). */
  instruccion?: string;
}): Promise<GuionIA> {
  const { texto, cfg, instruccion } = opts;
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "Falta ANTHROPIC_API_KEY en el entorno." };
  }
  const imagenes = (opts.imagenes ?? []).filter(Boolean).slice(0, MAX_IMAGENES_GUION);
  if (!imagenes.length) {
    return {
      ok: false,
      error:
        "No hay ninguna imagen cargada. El guion se escribe MIRANDO las fotos: sin ellas " +
        "solo saldría el texto troceado, que es lo que hacía la versión anterior.",
    };
  }

  const modelo = cfg.modelo || "claude-opus-5";
  const marca = opts.marca ?? null;
  const defecto = { texto, imagenes, marca: marca ?? undefined };

  // Las fotos primero y la instrucción después: el modelo tiene que haberlas visto antes
  // de leer lo que se le pide de ellas.
  const contenido: any[] = imagenes.map((url) => ({
    type: "image",
    source: { type: "url", url },
  }));
  contenido.push({
    type: "text",
    text: [
      `Esas son las ${imagenes.length} foto(s), en orden (la primera es la 0).`,
      "",
      "Texto de la publicación de hoy (es el CONTEXTO, no el texto de pantalla):",
      texto.trim(),
      instruccion?.trim() ? `\nLo que pide el operador para este guion: ${instruccion.trim()}` : "",
      "\nEscribe el guion.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  try {
    const resp: any = await anthropic.messages.create({
      model: modelo,
      max_tokens: 3000,
      system: sistemaGuion(cfg, imagenes.length, marca),
      messages: [{ role: "user", content: contenido }],
      ...modelExtras(modelo),
    } as any);

    const salida = (resp.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    const json = extraerJson(salida);
    if (!json) return { ok: false, error: "El modelo no devolvió un guion utilizable." };

    const norm = normalizarGuion(json, defecto);
    // `usoDefecto` significa que no quedó NADA del guion del modelo. Devolverlo como éxito
    // haría que la pantalla dijera «guion escrito por la IA» sobre el reparto automático.
    if (norm.usoDefecto) {
      return { ok: false, error: "El modelo no devolvió ninguna escena válida." };
    }
    return { ok: true, guion: norm.guion, avisos: norm.avisos, modelo };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export type ResultadoPropuesta = {
  ok: boolean;
  publicacion_id?: number;
  texto?: string;
  error?: string;
  /** La propuesta se creó pero algo accesorio falló. No es un fallo de guardado. */
  aviso?: string;
};

/**
 * Crea (o rehace) la propuesta de un día.
 *
 * NUNCA pisa una publicación aprobada ni cerrada: el operador ya la firmó, y
 * reescribirle el texto desde un cron sería cambiar lo que una persona aprobó sin que
 * nadie se entere. Solo se rehace una `propuesta`.
 */
export async function proponerPublicacion(opts: {
  fecha: string;
  instruccion?: string;
  rehacer?: boolean;
}): Promise<ResultadoPropuesta> {
  const sb = db();
  if (!sb) return { ok: false, error: "Sin credenciales de Supabase en el servidor." };

  const cfg = await leerConfig();
  if (!cfg) {
    return {
      ok: false,
      error:
        "No existe la configuración de /redes. Corre supabase/redes-01-publicaciones.sql " +
        "en Supabase → SQL Editor.",
    };
  }

  const { data: existente } = await sb
    .from("redes_publicaciones")
    .select("id, estado")
    .eq("fecha", opts.fecha)
    .neq("estado", "descartada")
    .maybeSingle();

  if (existente && existente.estado !== "propuesta") {
    return {
      ok: false,
      error: `La publicación del ${opts.fecha} ya está «${existente.estado}» y no se reescribe.`,
    };
  }
  if (existente && !opts.rehacer) {
    return { ok: true, publicacion_id: existente.id, aviso: "Ya había una propuesta para ese día." };
  }

  // Redes por defecto: las que tienen cuenta vigente. Proponer para una red sin
  // conectar llenaría la pantalla de ámbares el primer día, antes de que nadie haya
  // tenido ocasión de conectar nada.
  const { data: cuentas } = await sb.from("redes_cuentas").select("red").eq("vigente", true);
  const redes = ((cuentas ?? []).map((c: any) => c.red) as Red[]).filter(Boolean);

  const { data: previas } = await sb
    .from("redes_publicaciones")
    .select("texto")
    .lt("fecha", opts.fecha)
    .neq("estado", "descartada")
    .order("fecha", { ascending: false })
    .limit(5);

  const prop = await redactarPublicacion({
    fecha: opts.fecha,
    redes: redes.length ? redes : (["instagram"] as Red[]),
    cfg,
    instruccion: opts.instruccion,
    recientes: (previas ?? []).map((p: any) => p.texto).filter(Boolean),
  });
  if (!prop.ok) return { ok: false, error: prop.error };

  const patch = {
    fecha: opts.fecha,
    hora_programada_min: cfg.hora_publicar_min ?? 480,
    texto: prop.texto,
    titulo: prop.titulo ?? null,
    // NACE EN `propuesta`. Es el trato del módulo entero y no hay ninguna rama que lo
    // cambie: publicar exige `aprobada`, y eso solo lo escribe una persona.
    estado: "propuesta" as const,
    origen: "ia" as const,
    ia_modelo: prop.modelo ?? null,
    ia_tema: prop.tema ?? null,
    ia_texto_original: prop.texto,
    redes: redes.length ? redes : undefined,
    actualizado_en: new Date().toISOString(),
  };

  if (existente) {
    const { error } = await sb.from("redes_publicaciones").update(patch).eq("id", existente.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, publicacion_id: existente.id, texto: prop.texto };
  }

  const { data, error } = await sb.from("redes_publicaciones").insert(patch).select("id").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, publicacion_id: data.id, texto: prop.texto };
}
