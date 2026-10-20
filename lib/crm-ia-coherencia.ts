// lib/crm-ia-coherencia.ts — EL AUDITOR DE LA CONFIGURACIÓN DEL AGENTE IA DEL CRM. Módulo PURO: no
// lee la base, no llama a la IA y no mira el reloj. Lo importan /crm/agente (que avisa en vivo) y
// scripts/diagnostico-crm-ia-coherencia.mts.
//
// POR QUÉ EXISTE. Un mismo comportamiento podía estar escrito dos veces: en un AJUSTE (/crm/agente →
// Ajustes, `crm_agentes_ia.comportamiento`) y en un TEXTO LIBRE («Sobre la empresa», la persona, la
// base de conocimiento, los objetivos, las reglas del negocio). Se contradecían y nadie sabía cuál
// ganaba. La regla es una: en un tema que tiene ajuste MANDA EL AJUSTE (el prompt lo declara en
// «Ajustes del agente»). Este módulo encuentra la frase exacta que choca, dice qué ajuste manda y
// cómo arreglarlo. NUNCA bloquea el guardado ni edita el texto del dueño: avisa.
//
// CÓMO DETECTA (sin IA, por familias de expresiones):
//  1. La unidad es la FRASE: el texto se parte por saltos de línea y por fin de oración, pero NO
//     dentro de comillas ni de paréntesis (un mensaje citado de dos oraciones es una sola plantilla,
//     y «Molestia / Queja: "…Le comunico con un asesor…"» tiene que leerse junto).
//  2. Se compara sobre el texto normalizado (minúsculas, sin tildes, espacios colapsados). Lo que la
//     tilde distingue («de tú» frente a «de tu empresa») y los nombres propios se miran en el crudo.
//  3. Cada familia exige su disparador Y el ancla del tema en la misma frase: sin ancla no hay
//     hallazgo. Un aviso que sale siempre se vuelve paisaje, y entonces nadie lee el que importa.
//  4. El trato NUNCA se deduce de los verbos de las instrucciones al modelo («Realiza», «muestra»
//     son tú dirigido a la IA, no al cliente). Solo cuentan las declaraciones explícitas («siempre
//     de usted», «tutea»), los mensajes citados entre comillas de 4 palabras o más, y el mensaje de
//     derivación entero.
//  5. Con el ajuste en un valor, el choque es solo texto ↔ ajuste. Texto ↔ texto solo en temas sin
//     ajuste en uso (el horario de atención sin declarar).
//  6. Los números se extraen y se comparan: igual = repite (gris); distinto = contradice (ámbar).
//
// QUÉ NO MIRA, a propósito: `hora_inicio`/`hora_fin` del agente (es el horario en que la IA contesta
// SOLA, otro concepto que el horario de atención del equipo), `campos_pedido` y `lugares_conocidos`
// como texto (son ajustes, no instrucciones). Y ninguna palabra de una empresa concreta: el ERP se
// vende, y los nombres salen del perfil y de la configuración.

import {
  normalizarAjustes, presentacion, tituloResumen, TEMAS_AJUSTE, MOTIVOS_DERIVACION_SISTEMA,
  TRATAMIENTOS, MODOS_PREGUNTAS, RESUMEN_CUANDO,
  type AjustesIA, type ClaveAjuste, type TemaAjusteConAjuste, type Tratamiento, type ModoPreguntas,
  type ResumenCuando,
} from "@/lib/crm-ia-ajustes";
import {
  atencionDe, atencionEnUso, atencionValida, describirAtencion, describirDias, problemaAtencion,
  PROBLEMA_ATENCION, type Atencion,
} from "@/lib/crm-ia-atencion";

// ── Tipos ─────────────────────────────────────────────────────────────────────────────────────────

/** Los temas con ajuste (lib/crm-ia-ajustes.ts) más los tres que no lo tienen: lo que el sistema no
 *  puede hacer (seguimiento, llamada) y lo que decide el cotizador de traslados. */
export type TemaAjuste = TemaAjusteConAjuste | "seguimiento" | "llamada" | "traslados";

export type Relacion =
  | "contradice" | "plantilla" | "duplica" | "sin_ajuste" | "textos_chocan" | "imposible" | "ajustes_chocan";

/** Los textos que escribe el dueño. `reglas_extra` vive en `comportamiento`; `mensaje_derivacion` es
 *  una columna, y es a la vez un texto (un mensaje para el cliente) y un ajuste. */
export type CampoTexto = "persona" | "empresa_contexto" | "conocimiento" | "goals" | "reglas_extra" | "mensaje_derivacion";

export const CAMPOS_TEXTO: CampoTexto[] = ["persona", "empresa_contexto", "conocimiento", "goals", "reglas_extra", "mensaje_derivacion"];

/** El nombre con que el dueño ve cada campo. En los objetivos se le agrega el número y el título. */
export const ETIQUETA_CAMPO: Record<CampoTexto, string> = {
  persona: "Personalidad y tono",
  empresa_contexto: "Sobre la empresa",
  conocimiento: "Base de conocimiento",
  goals: "Objetivos",
  reglas_extra: "Reglas propias del negocio",
  mensaje_derivacion: "Mensaje al derivar a un ejecutivo",
};

/** Orden en que se listan los temas (y los grupos de la pantalla). */
export const TEMAS_COHERENCIA: TemaAjuste[] = [
  "tratamiento", "preguntas", "resumen", "saludo", "presentacion", "identidad_ia", "archivos", "audios",
  "direccion", "derivacion", "pausa_humano", "horario", "seguimiento", "llamada", "traslados",
];

type FilaTabla = { alarma: boolean; relacion: Relacion; titulo: string; arreglo: string };

/** Un código por choque, con su gravedad DECLARADA (ámbar = alarma; gris = repite un ajuste o solo
 *  informa). El título es el que ve el dueño; el arreglo de cada hallazgo lo concreta con los valores
 *  de su configuración. La pantalla enruta por código, nunca por el texto. */
const TABLA = {
  // ── Trato
  "tratamiento.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite cómo se trata al cliente",
    arreglo: "No hace falta cambiarla: el ajuste «Cómo trata al cliente» ya lo dice. Si algún día cambias el ajuste, esta frase quedará contradiciéndolo.",
  },
  "tratamiento.contradice": {
    alarma: true, relacion: "contradice", titulo: "Pide otro trato al cliente que el del ajuste",
    arreglo: "Manda el ajuste «Cómo trata al cliente». Si lo que quieres es lo que dice tu texto, cambia el ajuste; si no, borra la frase.",
  },
  "tratamiento.plantilla": {
    alarma: true, relacion: "plantilla", titulo: "Un mensaje de ejemplo está escrito en el otro trato",
    arreglo: "Reescribe el mensaje en el trato del ajuste «Cómo trata al cliente»: si la IA lo copia, el cliente leerá los dos tratos en el mismo chat.",
  },
  // ── Cómo se piden los datos
  "preguntas.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite cómo se piden los datos que faltan",
    arreglo: "No hace falta cambiarla: el ajuste «Cómo pide los datos que faltan» ya lo dice.",
  },
  "preguntas.contradice": {
    alarma: true, relacion: "contradice", titulo: "Pide los datos que faltan de otra forma que el ajuste",
    arreglo: "Manda el ajuste «Cómo pide los datos que faltan». Si lo que quieres es lo que dice tu texto, cambia el ajuste; si no, borra la frase.",
  },
  // ── Resumen del pedido
  "resumen.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite cómo se muestra el resumen del pedido",
    arreglo: "No hace falta cambiarla: el ajuste del resumen del pedido ya lo dice.",
  },
  "resumen.contradice": {
    alarma: true, relacion: "contradice", titulo: "Pide el resumen del pedido en otro momento que el ajuste",
    arreglo: "Manda el ajuste «Cuándo muestra el resumen del pedido». Si lo que quieres es lo que dice tu texto, cambia el ajuste; si no, borra la frase.",
  },
  "resumen.plantilla_propia": {
    alarma: true, relacion: "plantilla", titulo: "Trae su propia plantilla de resumen",
    arreglo: "El resumen lo arma el ajuste del resumen del pedido. Escribe tu título y tu cierre en «Título del resumen» y «Cierre del resumen», y borra la plantilla del texto: si no, la IA tendrá dos formatos.",
  },
  "resumen.sin_ajuste": {
    alarma: false, relacion: "sin_ajuste", titulo: "Pide un resumen del pedido y el ajuste del resumen está apagado",
    arreglo: "Con el ajuste apagado manda tu texto. Si prefieres decidirlo con el ajuste, enciende el resumen del pedido y elige cuándo se muestra.",
  },
  // ── Saludo
  "saludo.propio": {
    alarma: true, relacion: "plantilla", titulo: "Trae su propio saludo o menú inicial",
    arreglo: "Lo que se ofrece cuando el cliente solo saluda lo decide el ajuste «Qué ofrece cuando el cliente solo saluda». Copia ahí tu menú y borra la frase: si no, la IA tendrá dos saludos.",
  },
  "saludo.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite el saludo o el menú inicial",
    arreglo: "No hace falta cambiarla: el menú ya está en el ajuste «Qué ofrece cuando el cliente solo saluda». Si cambias el menú del ajuste, esta frase quedará diciendo otra cosa.",
  },
  // ── Presentación
  "presentacion.distinta": {
    alarma: true, relacion: "contradice", titulo: "Se presenta con otro nombre que el del ajuste",
    arreglo: "Manda el ajuste «Cómo se presenta». Si el agente tiene nombre propio, escríbelo en «Nombre del agente» y pon {agente} en «Cómo se presenta»; si no, cambia el nombre del texto.",
  },
  "presentacion.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite cómo se presenta",
    arreglo: "No hace falta cambiarla: el ajuste «Cómo se presenta» ya usa ese nombre.",
  },
  "presentacion.sin_nombre": {
    alarma: true, relacion: "ajustes_chocan", titulo: "«Cómo se presenta» usa el nombre del agente y el agente no tiene nombre",
    arreglo: "Escribe el nombre en «Nombre del agente», o quita {agente} de «Cómo se presenta».",
  },
  // ── Decir que es una IA
  "identidad_ia.contradice": {
    alarma: true, relacion: "contradice", titulo: "Se presenta como asistente virtual y el ajuste pide no decirlo",
    arreglo: "Está marcado «No decir que es una IA salvo que se lo pregunten». Quita de la frase «virtual» (o IA, o bot), o desmarca el ajuste si no te importa que lo diga.",
  },
  "identidad_ia.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite que no diga que es una IA",
    arreglo: "No hace falta cambiarla: el ajuste «No decir que es una IA salvo que se lo pregunten» ya lo dice.",
  },
  "identidad_ia.ajustes_chocan": {
    alarma: true, relacion: "ajustes_chocan", titulo: "«Cómo se presenta» dice que es virtual y otro ajuste pide no decirlo",
    arreglo: "Quita «virtual» (o IA, o bot) de «Cómo se presenta», o desmarca «No decir que es una IA salvo que se lo pregunten».",
  },
  "identidad_ia.sin_ajuste": {
    alarma: false, relacion: "sin_ajuste", titulo: "Pide no decir que es una IA y el ajuste está desmarcado",
    arreglo: "Con el ajuste desmarcado manda tu texto. Si prefieres decidirlo con el ajuste, marca «No decir que es una IA salvo que se lo pregunten».",
  },
  // ── Archivos y audios
  "archivos.contradice": {
    alarma: true, relacion: "contradice", titulo: "Dice lo contrario de lo que hace la IA con las fotos y los PDF",
    arreglo: "Manda el ajuste «Leer fotos y PDF». Borra la frase o cambia el ajuste.",
  },
  "archivos.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite lo que hace la IA con las fotos y los PDF",
    arreglo: "No hace falta cambiarla: el ajuste «Leer fotos y PDF» ya lo dice.",
  },
  "audios.contradice": {
    alarma: true, relacion: "contradice", titulo: "Dice lo contrario de lo que hace la IA con las notas de voz",
    arreglo: "Manda el ajuste «Escuchar notas de voz». Borra la frase o cambia el ajuste.",
  },
  "audios.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite lo que hace la IA con las notas de voz",
    arreglo: "No hace falta cambiarla: el ajuste «Escuchar notas de voz» ya lo dice.",
  },
  // ── Dirección exacta
  "direccion.contradice": {
    alarma: true, relacion: "contradice", titulo: "Exige la dirección exacta siempre, y hay lugares que no la necesitan",
    arreglo: "Manda el ajuste «Lugares que no necesitan dirección exacta». Agrega a la frase «salvo» esos lugares, bórrala, o vacía el ajuste si también ahí quieres la dirección exacta.",
  },
  "direccion.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite qué lugares no necesitan dirección exacta",
    arreglo: "No hace falta cambiarla: el ajuste «Lugares que no necesitan dirección exacta» ya lo dice.",
  },
  // ── Pasar a una persona
  "derivacion.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite cuándo se pasa el chat a una persona",
    arreglo: "No hace falta cambiarla: el sistema ya pasa el chat a una persona en esos casos y, al hacerlo, aparta a la IA de ese chat.",
  },
  // ── Pausa cuando contesta una persona
  "pausa_humano.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite cuántas horas se aparta la IA cuando contesta una persona",
    arreglo: "No hace falta cambiarla: la pausa la hace el sistema con el ajuste «Pausa tras respuesta humana (horas)».",
  },
  "pausa_humano.contradice": {
    alarma: true, relacion: "contradice", titulo: "Pide apartar la IA otras horas que el ajuste",
    arreglo: "Manda el ajuste «Pausa tras respuesta humana (horas)». Pon ahí las horas que quieres y borra la frase: la pausa la hace el sistema.",
  },
  // ── Horario de atención del equipo
  "horario.duplica": {
    alarma: false, relacion: "duplica", titulo: "Repite el horario de atención del equipo",
    arreglo: "No hace falta cambiarla: el ajuste «Horario de atención del equipo» ya lo dice. Si cambias el ajuste, corrige también esta frase.",
  },
  "horario.contradice": {
    alarma: true, relacion: "contradice", titulo: "Dice otro horario de atención que el del ajuste",
    arreglo: "Manda el ajuste «Horario de atención del equipo». Corrige la frase o el ajuste para que digan lo mismo.",
  },
  "horario.textos_chocan": {
    alarma: true, relacion: "textos_chocan", titulo: "Dos textos dicen horarios de atención distintos",
    arreglo: "Declara el horario correcto en el ajuste «Horario de atención del equipo» y corrige o borra las frases que digan otro.",
  },
  "horario.sin_ajuste": {
    alarma: false, relacion: "sin_ajuste", titulo: "Escribe un horario de atención que no está en el ajuste",
    arreglo: "Decláralo en el ajuste «Horario de atención del equipo»: así la IA y el mensaje de derivación dirán cuándo responde una persona fuera de ese horario.",
  },
  "horario.cierres_por_hora": {
    alarma: false, relacion: "sin_ajuste", titulo: "Arma mensajes de cierre según la hora",
    arreglo: "Con el «Horario de atención del equipo» declarado, el mensaje de derivación ya dice cuándo responde un ejecutivo. Revisa que estos cierres digan lo mismo.",
  },
  "horario.invalido": {
    alarma: true, relacion: "ajustes_chocan", titulo: "El horario de atención del equipo no se puede usar",
    arreglo: "Corrige los días o las horas del ajuste «Horario de atención del equipo»: mientras no sea válido, no se usa.",
  },
  "horario.derivacion_sin_atencion": {
    alarma: false, relacion: "plantilla", titulo: "Tu mensaje de derivación no dice el horario de atención",
    arreglo: "Escribe {atencion} donde quieras la frase del horario: fuera de horario se reemplaza por «Nuestro horario de atención es…; un ejecutivo le responderá…» y en horario desaparece.",
  },
  // ── Lo que el sistema no puede hacer
  "seguimiento.imposible": {
    alarma: true, relacion: "imposible", titulo: "Pide recordatorios que el sistema no puede enviar",
    arreglo: "La IA solo contesta cuando el cliente escribe: no puede mandar un recordatorio ni un mensaje de seguimiento si el cliente no responde. Borra estas instrucciones.",
  },
  "llamada.imposible": {
    alarma: true, relacion: "imposible", titulo: "Pide llamar al cliente por teléfono",
    arreglo: "La IA solo escribe por el chat: no puede llamar. Borra la frase o pide que derive a un ejecutivo para que él lo llame.",
  },
  // ── Cotizador de traslados (solo con los traslados encendidos)
  "traslados.varias_unidades": {
    alarma: false, relacion: "sin_ajuste", titulo: "Pide sugerir varios vehículos; en traslados eso ya va a un ejecutivo",
    arreglo: "Un traslado que necesita más de un vehículo no lo cotiza el cotizador de traslados: lo pasa a un ejecutivo. La frase sigue valiendo para los demás servicios.",
  },
  "traslados.hoy": {
    alarma: true, relacion: "contradice", titulo: "Manda los pedidos para hoy a una persona, pero el cotizador de traslados también cotiza los de hoy",
    arreglo: "Con los traslados por zona encendidos, la IA cotiza también un traslado para hoy con el tarifario y puede enviarlo sola. Si eso está bien, aclara en la frase «salvo los traslados»; si no, bórrala o apaga la cotización automática de traslados.",
  },
} as const satisfies Record<string, FilaTabla>;

export type CodigoCoherencia = keyof typeof TABLA;
export const TABLA_HALLAZGOS: Record<CodigoCoherencia, FilaTabla> = TABLA;

export type Hallazgo = {
  /** "<tema>.<variante>". */
  codigo: CodigoCoherencia;
  tema: TemaAjuste;
  relacion: Relacion;
  /** SIEMPRE el de la tabla. */
  alarma: boolean;
  /** null = el choque es entre ajustes (no hay texto que editar). */
  campo: CampoTexto | null;
  /** Nº de objetivo (desde 1) cuando el campo es `goals`. */
  indice?: number;
  /** «Sobre la empresa», «Objetivo 2: Cotizar», o el ajuste cuando campo es null. */
  etiquetaCampo: string;
  /** La frase tal cual (≤ 200 caracteres; si se cortó, termina en «…»). Con campo null, el valor
   *  del ajuste que choca. */
  cita: string;
  /** Solo en `textos_chocan`: la otra frase. */
  otra?: { campo: CampoTexto; etiquetaCampo: string; cita: string; indice?: number };
  /** El ajuste que manda (null en lo que no tiene ajuste: seguimiento, llamada, traslados). */
  ajuste: { clave: ClaveAjuste; etiqueta: string; ancla: string; valorLegible: string } | null;
  /** Solo en temas de opciones (trato, preguntas, cuándo el resumen) cuando el texto equivale a UN
   *  valor: poner el ajuste en ese valor convierte el choque en una frase que repite (gris). */
  propuesta?: { clave: ClaveAjuste; valor: unknown; etiqueta: string };
  titulo: string;
  arreglo: string;
};

export type ConfigAuditable = {
  persona?: string | null;
  empresa_contexto?: string | null;
  conocimiento?: string | null;
  goals?: unknown;
  mensaje_derivacion?: string | null;
  escalar_si?: string | null;
  /** crm_agentes_ia.nombre (lo que reemplaza {agente}). */
  nombre?: string | null;
  pausa_humano_horas?: number | string | null;
  comportamiento?: unknown;
};

export type ResultadoAuditoria = {
  hallazgos: Hallazgo[];
  alarmas: number;
  grises: number;
  /** Cuántas ALARMAS por tema (lo que pinta un aviso ámbar). */
  porTema: Partial<Record<TemaAjuste, number>>;
  /** Cuántas ALARMAS por campo ("ajustes" = las que no tienen texto). En `textos_chocan` cuentan
   *  los dos campos. */
  porCampo: Record<string, number>;
};

// ── Texto ─────────────────────────────────────────────────────────────────────────────────────────

/** Minúsculas, sin tildes (la ñ pasa a n), espacios colapsados. Solo para COMPARAR: nunca se muestra. */
export function normalizarTexto(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const MAX_CITA = 200;
/** La frase para mostrar: hasta 200 caracteres, cortada en palabra y con «…» si se cortó. */
function recortarCita(s: string): string {
  const c = Array.from(s.trim());
  if (c.length <= MAX_CITA) return c.join("");
  let corte = c.slice(0, MAX_CITA - 1).join("");
  const esp = corte.lastIndexOf(" ");
  if (esp > MAX_CITA / 2) corte = corte.slice(0, esp);
  return `${corte.replace(/[\s,;:]+$/, "")}…`;
}

type Frase = { texto: string; norm: string; inicio: number };

/** Abreviaturas tras las que un punto no cierra la oración («Sr. Pérez», «(Ej. …)»). */
const ABREVIATURAS = new Set([
  "ej", "sr", "sra", "srta", "sres", "dr", "dra", "ing", "lic", "av", "jr", "nro", "aprox", "pag", "tel", "cel",
  "dpto", "urb", "mz", "lt", "prov", "dist", "ref",
]);

/** Parte un texto en frases: por línea y por fin de oración seguido de mayúscula, ¿, ¡ o una
 *  comilla. No parte dentro de comillas ni de paréntesis, ni tras una abreviatura. */
export function partirFrases(texto: string): Frase[] {
  const out: Frase[] = [];
  const agregar = (crudo: string, inicio: number) => {
    const lead = crudo.length - crudo.trimStart().length;
    const t = crudo.trim();
    if (t) out.push({ texto: t, norm: normalizarTexto(t), inicio: inicio + lead });
  };
  let base = 0;
  for (const linea of texto.split("\n")) {
    let ini = 0;
    let recta = false;
    let angulares = 0, curvas = 0, paren = 0;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (c === '"') { recta = !recta; continue; }
      if (c === "«") { angulares++; continue; }
      if (c === "»") { angulares = Math.max(0, angulares - 1); continue; }
      if (c === "“") { curvas++; continue; }
      if (c === "”") { curvas = Math.max(0, curvas - 1); continue; }
      if (c === "(") { paren++; continue; }
      if (c === ")") { paren = Math.max(0, paren - 1); continue; }
      if (!/\s/.test(c) || recta || angulares || curvas || paren) continue;
      let j = i - 1;
      while (j >= ini && /["»”)]/.test(linea[j])) j--;
      if (j < ini || !/[.!?…]/.test(linea[j])) continue;
      if (linea[j] === ".") {
        const palabra = /(\p{L}+)\.$/u.exec(linea.slice(ini, j + 1));
        if (palabra && ABREVIATURAS.has(palabra[1].toLowerCase())) continue;
      }
      let k = i;
      while (k < linea.length && /\s/.test(linea[k])) k++;
      if (k >= linea.length || !/[A-ZÁÉÍÓÚÑÜ¿¡"«“]/.test(linea[k])) continue;
      agregar(linea.slice(ini, i), base + ini);
      ini = k;
      i = k - 1;
    }
    agregar(linea.slice(ini), base + ini);
    base += linea.length + 1;
  }
  return out;
}

/** Los mensajes citados del texto («…», “…” o "…" en una línea) de 4 palabras o más: plantillas
 *  que la IA puede copiar al cliente. */
function segmentosCitados(texto: string): { texto: string; inicio: number }[] {
  const out: { texto: string; inicio: number }[] = [];
  const re = /«([^»]{1,3000})»|“([^”]{1,3000})”|"([^"\n]{1,3000})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const t = m[1] ?? m[2] ?? m[3] ?? "";
    const palabras = t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    if (palabras >= 4) out.push({ texto: t, inicio: m.index + 1 });
  }
  return out;
}

const tiene = (re: RegExp, s: string) => re.test(s);

// ── Familias de expresiones (sobre el texto normalizado salvo que se diga) ───────────────────────

// Trato
const RE_TRATO_USTED = /\bde usted\b|\bustedea\w*|\b(no|nunca|jamas|sin|evita)\b(?: \w+){0,2} (tute\w*|tuteo)\b/;
const RE_TUTEO_NEGADO = /\b(no|nunca|jamas|sin|evita)\b(?: \w+){0,2} (tute\w*|tuteo)\b/g;
const RE_TUTEO_DEL_CLIENTE = /\b(si|aunque|cuando)( el cliente| la persona| el usuario)?( te| lo| le)? tute\w*|\b(cliente|usuario|persona)s?( te| lo| le)? tute\w*/g;
const RE_TUTEO = /\b(tute\w*|tuteo)\b/;
const RE_DE_TU_CRUDO = /(^|[^\p{L}])de\s+tú(?![\p{L}])/iu;
const RE_DE_TU_NEGADO_CRUDO = /(^|[^\p{L}])(no|nunca|jamás|jamas)\s+(\p{L}+\s+){0,2}de\s+tú(?![\p{L}])/iu;

/** El trato que DECLARA una frase («siempre de usted», «tutea al cliente»), o null. Con las dos
 *  cosas a la vez (un trato por segmento de cliente) no se afirma ninguna. */
function tratoDeclarado(f: Frase): Tratamiento | null {
  const s = f.norm.replace(RE_TUTEO_DEL_CLIENTE, " ");
  const usted = RE_TRATO_USTED.test(s) || RE_DE_TU_NEGADO_CRUDO.test(f.texto);
  const tu = RE_TUTEO.test(s.replace(RE_TUTEO_NEGADO, " ")) || (RE_DE_TU_CRUDO.test(f.texto) && !RE_DE_TU_NEGADO_CRUDO.test(f.texto));
  if (usted && tu) return null;
  return usted ? "usted" : tu ? "tu" : null;
}

const VERBOS_ENCLITICOS = "ayudar|brindar|enviar|escribir|atender|comunicar|contactar|indicar|confirmar|cotizar|llamar|responder|saludar|ofrecer|informar|recomendar|explicar|asesorar";
const RAICES_PRONOMBRE = "escrib|envi|ayud|confirm|respond|llam|indic|comunic|contact|atiend|cotiz|ofrec|recomiend";
const RE_MARCA_TU = new RegExp(
  `\\b(${VERBOS_ENCLITICOS})te\\b|\\b(tu|tus) (solicitud|pedido|traslado|reserva|nombre|datos|servicio|consulta|cotizacion|viaje|necesidad|empresa)\\b|\\bte (${RAICES_PRONOMBRE})\\w*|\\b(puedes|quieres|necesitas|tienes|deseas|prefieres)\\b|\\b(indicame|escribeme|enviame|dime|cuentame|confirmame|avisame)\\b`,
);
const RE_MARCA_USTED = new RegExp(
  `\\busted(es)?\\b|\\b(${VERBOS_ENCLITICOS})le\\b|\\ble (${RAICES_PRONOMBRE})\\w*|\\b(indiqueme|escribame|envieme|digame|cuenteme|confirmeme|aviseme|comuniquese)\\b`,
);
const marcaDelTrato = (t: Tratamiento) => (t === "tu" ? RE_MARCA_TU : RE_MARCA_USTED);
const otroTrato = (t: Tratamiento): Tratamiento => (t === "tu" ? "usted" : "tu");

// Cómo se piden los datos
const RE_UNA = /\buna (sola )?pregunta (por|a la) (vez|turno|mensaje)\b|\bun (solo )?dato (por|a la) (vez|turno|mensaje)\b|\bde (a )?uno en uno\b|\bno (agrupar|agrupes|adelantar|adelantes)\b/;
const RE_JUNTO = /\b(todo|todos los datos|todas las preguntas|todo lo que falt\w*)\b.{0,40}\b(junt\w*|en un (solo|unico) mensaje)\b/;
const RE_JUNTO_NEGADO = /\bno\b (\w+ ){0,2}(pidas|preguntes|pedir|preguntar)\b.{0,10}\b(todo|todos|todas)\b.{0,40}\b(junt\w*|en un (solo|unico) mensaje)\b/;
const RE_ANCLA_UNA = /pregunt|\bdatos?\b/;
const RE_ANCLA_JUNTO = /pregunt|\bdatos?\b|\bpid|falt/;

function preguntasDeclaradas(f: Frase): ModoPreguntas | null {
  const n = f.norm;
  const una = (RE_UNA.test(n) && RE_ANCLA_UNA.test(n)) || RE_JUNTO_NEGADO.test(n);
  const junto = RE_JUNTO.test(n) && RE_ANCLA_JUNTO.test(n) && !RE_JUNTO_NEGADO.test(n);
  if (una && junto) return null;
  return una ? "una_por_mensaje" : junto ? "todo_junto" : null;
}

// Resumen
const RE_ANCLA_RESUMEN = /resum/;
const RE_CADA = /\b(en|al final de) cada (mensaje|respuesta)\b/;
const RE_CADA_NEGADO = /\b(no|nunca|ni|sin|jamas)\b[^.]{0,60}\b(en|al final de) cada (mensaje|respuesta)\b/;
const RE_AL_FINAL = /\bal final\b(?! de cada)/;

function resumenCuandoDeclarado(f: Frase): ResumenCuando | null {
  const n = f.norm;
  if (!RE_ANCLA_RESUMEN.test(n)) return null;
  if (RE_CADA.test(n)) return RE_CADA_NEGADO.test(n) ? "al_final" : "cada_respuesta";
  return RE_AL_FINAL.test(n) ? "al_final" : null;
}
const esPlantillaResumen = (f: Frase) =>
  RE_ANCLA_RESUMEN.test(f.norm) && (f.texto.includes("📋") || /plantilla de(l)? resumen/.test(f.norm) || /\bRESUMEN DE\b/.test(f.texto));
const esTituloResumen = (f: Frase) =>
  RE_ANCLA_RESUMEN.test(f.norm) && (f.texto.includes("📋") || /\bRESUMEN DE\b/.test(f.texto));
/** Para comparar títulos: solo letras y números. */
const soloPalabras = (s: string) => normalizarTexto(s).replace(/[^a-z0-9]+/g, " ").trim();

// Saludo
const RE_SALUDO = /\b(saludo|bienvenida|menu (inicial|principal))\b/;
const RE_SALUDO_ACCION = /\b(muestra|muestrale|responde|respondele|envia|enviale|usa|di|dile|saluda|ofrece|ofrecele|da|dale)\b/;
const RE_INICIO_SALUDO = /^[^\p{L}]*(hola|buenos dias|buenas tardes|buenas noches)\b/u;

// Presentación (en el crudo: el nombre propio va con mayúscula)
const RE_PRESENTACION = /(?:^|[^\p{L}])(Eres|eres|Soy|soy|Me llamo|me llamo)\s+([A-ZÁÉÍÓÚÑ][\p{L}\d]*)/gu;
const NO_SON_NOMBRES = new Set(["el", "la", "los", "las", "un", "una", "tu", "su", "de", "del", "parte", "quien", "yo", "nuestro", "nuestra", "aqui", "muy"]);

// Decir que es una IA
const RE_REVELA = /\b(soy|eres|me presento como|presentate como|te presentas como)\b[^.]{0,60}?\b(asistente virtual|chatbot|bot|robot|inteligencia artificial|ia)\b/;
const RE_REVELA_NEGADO = /\b(no|nunca)\s+(soy|eres)\b[^.]{0,20}\b(bot|robot|chatbot|ia)\b/;
const RE_PREGUNTA_SI_ES_BOT = /\beres (un |una )?(bot|robot|chatbot|ia|inteligencia artificial|humano|persona|maquina)\s*\?|\bsi (te|le) pregunta|\bsi (el cliente )?pregunta (si|que)\b/;
const RE_OCULTA = /\b(no|nunca|jamas)\b (le )?(digas|reveles|menciones|admitas|aclares|confieses|cuentes) (que )?(eres|es|sos) (una |un )?(ia|inteligencia artificial|bot|robot|chatbot|asistente virtual|maquina)\b|\boculta que (eres|es) (una |un )?(ia|bot|robot|inteligencia artificial)\b/;
const RE_VIRTUAL_EN_AJUSTE = /\b(virtual|ia|bot|chatbot|robot|inteligencia artificial)\b/;

// Archivos
const RE_ANCLA_ARCHIVO = /\b(archivos?|fotos?|imagen(es)?|pdfs?|documentos?|adjuntos?|capturas?)\b/;
const RE_NO_LEE = /\b(asesor|ejecutivo|equipo|persona)\b[^.]{0,20}\b(revis\w*|ver|vera|veran)\b|\bno (puedes|puedo|puede|podemos) (ver|abrir|leer)\b|\bhemos recibido (el|tu|su|los|sus) (archivo|documento|foto|imagen)/;
const RE_LEE = /\b(lee|leer|leelos|leelas|analiza|analizar|extrae)\b[^.]{0,20}\b(fotos?|archivos?|documentos?|pdfs?|imagen(es)?|adjuntos?)\b/;

// Audios
const RE_ANCLA_AUDIO = /\b(audios?|notas? de voz|mensajes? de voz|grabacion(es)?)\b/;
const RE_NO_ESCUCHA = /\bno (puedes|puedo|puede|podemos) (escuchar|oir|reproducir)\b|\bpid\w*( al cliente)? que (lo |la )?(escriba|escriban)\b|\b(asesor|ejecutivo|equipo)\b[^.]{0,20}\bescuch\w*/;
const RE_ESCUCHA = /\b(escucha|escuchalos|escuchalas|transcribe|transcribelos|transcribelas)\b[^.]{0,20}\b(audios?|notas? de voz|mensajes? de voz)\b/;

// Dirección exacta
const RE_DIRECCION = /\bdirecci(on|ones) (exactas?|completas?)\b|\bcalle y numero\b/;
const RE_DIRECCION_FUERTE = /obligatori|\bsiempre\b|\bnunca\b|critic|\bexig/;
const RE_DIRECCION_EXIME = /\b(salvo|excepto|menos|excepcion)\b|\bno (necesita|necesitan|hace falta|requiere|requieren|pidas|pedir)\b[^.]{0,20}\bdirecci|\bsin (pedir )?(la )?direccion (exacta|completa)\b/;

// Pasar a una persona
const RE_MOTIVO_DERIVA = /\b(molest\w*|queja\w*|reclamo\w*|enojad\w*|insatisfech\w*|furios\w*|disgustad\w*)\b/;
const RE_ACCION_DERIVA = /\b(deriv\w*|escal\w*|transfi\w*|comunic\w*|asesor\w*|ejecutiv\w*)\b|\bpasa\w* (el chat |la conversacion )?(a|con) (un|una|el|la) (persona|humano)\b/;

// Pausa cuando contesta una persona
const RE_PAUSA_QUIEN = /\b(asesor|humano|persona|ejecutivo|equipo|operador)\b[^.]{0,30}\b(interv\w*|respond\w*|contest\w*|escrib\w*)/;
const RE_PAUSA_QUE = /\b(silencio|pausa\w*)\b|\bno (respondas|intervengas|contestes|escribas)\b/;
const RE_PAUSA_HORAS = /\b(\d{1,3}) ?(h|horas?)\b/;

// Horario de atención
const RE_ANCLA_HORARIO = /\batencion\b|\batendemos\b|\batiende\w*\b|\batender\b|\bfuera de horario\b|\ben horario\b|\bhorario (de )?(atencion|oficina|comercial|laboral|de trabajo)\b|\bhorarios?\b(?! (\w+ ){0,2}(salida|retorno|recojo|servicio|ruta|viaje|llegada|partida|vuelo|bus|unidad))/;
const RE_URL_TEL = /https?:\/\/\S+|www\.\S+|\S+@\S+|\+?\d[\d \-]{7,}\d/g;
const RE_RANGO_HORAS = /(?<![\d:])(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|horas?\b|hrs?\b|h\b)?\s*(?:a|-|–|—|hasta|al)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|horas?\b|hrs?\b|h\b)?(?![\d:])/;
const RE_RANGO_DIAS = /\b(lun|mar|mie|jue|vie|sab|dom)[a-z]*\.?\s*(?:a|-|–|al|hasta)\s*(lun|mar|mie|jue|vie|sab|dom)[a-z]*/;
const DIA_DE: Record<string, number> = { dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 };
const RE_CIERRE_POR_HORA = /\b(despues|antes|a partir) de las \d/;
const RE_CIERRE_ACCION = /\b(respond\w*|di|dile|indica|mensaje|cierre)\b/;
const RE_CIERRE_SEGUN_HORA = /\b(cierres?|mensajes?)\b[^.]{0,40}\bsegun (la |el )?hora/;

type DeclHorario = { desde: string; hasta: string; dias: number[] | null };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Un rango COMPLETO de horas con su ancla de atención en la misma frase («Horario de atención: de
 *  9:00 AM a 5:00 PM», «Lun-Sáb 8:00-20:00»). Sin «:MM», am/pm ni «h» no se lee (un «10-15 pax» no
 *  es un horario). */
function horarioDeclarado(f: Frase): DeclHorario | null {
  const n = f.norm.replace(RE_URL_TEL, " ");
  if (!RE_ANCLA_HORARIO.test(n)) return null;
  const m = RE_RANGO_HORAS.exec(n);
  if (!m) return null;
  const [, h1, m1, s1, h2, m2, s2] = m;
  if (!(m1 || s1 || m2 || s2)) return null;
  const sufijo = (s?: string) => (!s ? null : s.startsWith("a") ? "am" : s.startsWith("p") ? "pm" : "h");
  const a1 = sufijo(s1), a2 = sufijo(s2);
  let x = Number(h1), y = Number(h2);
  const mx = Number(m1 ?? 0), my = Number(m2 ?? 0);
  if (x > 24 || y > 24 || mx > 59 || my > 59) return null;
  const aMil = (h: number, s: string | null) => (s === "pm" && h < 12 ? h + 12 : s === "am" && h === 12 ? 0 : h);
  // Si solo un lado dice am/pm: «de 1 a 5 pm» son las 13:00, «de 9 a 5 pm» son las 09:00.
  const pmInicio = !a1 && a2 === "pm" && x < y;
  x = aMil(x, a1 ?? (pmInicio ? "pm" : null));
  y = aMil(y, a2 ?? (a1 === "pm" ? "pm" : null));
  const desde = x * 60 + mx, hasta = y * 60 + my;
  if (hasta <= desde || hasta > 24 * 60) return null;
  let dias: number[] | null = null;
  const d = RE_RANGO_DIAS.exec(n);
  if (d) {
    const ini = DIA_DE[d[1]], fin = DIA_DE[d[2]];
    dias = [];
    for (let k = ini; ; k = (k + 1) % 7) { dias.push(k); if (k === fin) break; }
    dias.sort((p, q) => p - q);
  }
  return { desde: hhmm(desde), hasta: hhmm(Math.min(hasta, 23 * 60 + 59)), dias };
}
const mismoHorario = (a: DeclHorario, b: DeclHorario) =>
  a.desde === b.desde && a.hasta === b.hasta && (!a.dias || !b.dias || a.dias.join(",") === b.dias.join(","));
const claveHorario = (h: DeclHorario) => `${h.desde}-${h.hasta}|${h.dias?.join(",") ?? "?"}`;
const describirDecl = (h: DeclHorario) => `${h.dias ? `${describirDias(h.dias)}, ` : ""}de ${h.desde} a ${h.hasta}`;

// Seguimiento (lo que el sistema no puede hacer)
const RE_SEG_QUE = /\b(recordatorios?|seguimiento|vuelve a escribir\w*|escribele (de nuevo|otra vez)|reenvia\w*)\b|\b(envia|enviale|manda|mandale) (un|el|otro) (segundo |ultimo |nuevo |otro )?(y ultimo )?(mensaje|recordatorio)\b/;
const RE_SEG_CUANDO = /\b(a los|tras|despues de|luego de|pasad[oa]s?|cada) \d+ ?(min\w*|h|horas?|dias?)\b/;
const RE_SEG_SILENCIO = /\bsi (el cliente )?(no (responde|contesta|confirma|escribe)|deja de (responder|escribir))\b/;
const RE_SEG_VERBO = /\b(envia\w*|escribe\w*|pregunta\w*|manda\w*|recuerda\w*|insiste)\b/;
const RE_SEG_NEGADO = /\b(no|nunca|ni)\b[^.]{0,20}\b(envies|mandes|hagas|aplicar|aplique|ofrezcas)\b[^.]{0,30}\b(recordatorios?|seguimiento|recuperacion)\b/;

// Llamar por teléfono
const RE_LLAMADA = /\bllama(r)? al cliente\b|\bllamal[oa]s?\b|\bllamale\b|\bhaz(le)? una llamada\b|\brealiza una llamada\b|\bllamada telefonica al cliente\b/;
const RE_LLAMADA_NEGADA = /\b(no|nunca)\b (\w+ ){0,2}llam/;

// Traslados
const RE_PAX_MUCHOS = /\b(mas de|sobre) \d+ ?(pasajeros|personas|pax)\b|\+ ?\d+ ?(pasajeros|personas|pax)\b|\d+ ?\+ ?(pasajeros|personas|pax)\b/;
const RE_VARIAS_UNIDADES = /\bcombinacion\b|\bvarias (unidades|vehiculos|movilidades)\b|\bvarios vehiculos\b|\bdos (buses|unidades|vehiculos|minibuses)\b|\bmas de un (bus|vehiculo|minibus)\b/;
const RE_URGENCIA_HOY = /\burgencia\w*\b|\burgente\w*\b|\bpara hoy\b|\bmismo dia\b|\(hoy\)|\bhoy o ya\b/;
const RE_URGENCIA_ACCION = /\bllam\w*|\bderiv\w*|\basesor\w*|\bejecutiv\w*|\btelefono\b|\bcomunic\w*|📞|\d{3}[ -]?\d{3}[ -]?\d{3}/;
/** «Urgencias, salvo los traslados: …»: la frase ya dejó fuera lo que cotiza el sistema. */
const RE_SALVO_TRASLADOS = /\b(salvo|excepto|menos)\b[^.]{0,30}\btraslado|\bque no (sea|sean|es|son) (un |una )?traslado|\btraslados?\b[^.]{0,30}\bse cotiza/;

// ── Fuentes de texto ──────────────────────────────────────────────────────────────────────────────

type Fuente = { campo: CampoTexto; indice?: number; texto: string; orden: number };

const str = (v: unknown) => (typeof v === "string" ? v : "");

function fuentesDe(cfg: ConfigAuditable, aj: AjustesIA): { fuentes: Fuente[]; titulos: Map<number, string> } {
  const fuentes: Fuente[] = [];
  const titulos = new Map<number, string>();
  let orden = 0;
  const poner = (campo: CampoTexto, texto: string, indice?: number) => {
    if (texto.trim()) fuentes.push({ campo, texto, orden: orden++, ...(indice != null ? { indice } : {}) });
  };
  poner("persona", str(cfg.persona));
  poner("empresa_contexto", str(cfg.empresa_contexto));
  poner("conocimiento", str(cfg.conocimiento));
  const goals = Array.isArray(cfg.goals) ? cfg.goals : [];
  goals.forEach((g: unknown, i: number) => {
    const o = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
    titulos.set(i + 1, str(o.titulo).trim());
    poner("goals", str(o.titulo), i + 1);
    poner("goals", str(o.instrucciones), i + 1);
  });
  poner("reglas_extra", aj.reglas_extra);
  return { fuentes, titulos };
}

function etiquetaDe(campo: CampoTexto, indice: number | undefined, titulos: Map<number, string>): string {
  if (campo !== "goals" || indice == null) return ETIQUETA_CAMPO[campo];
  const t = titulos.get(indice);
  return t ? `Objetivo ${indice}: ${t}` : `Objetivo ${indice}`;
}

// ── El auditor ────────────────────────────────────────────────────────────────────────────────────

type AjusteRef = NonNullable<Hallazgo["ajuste"]>;
type Candidato = {
  codigo: CodigoCoherencia;
  campo: CampoTexto | null;
  indice?: number;
  etiquetaCampo?: string;
  cita: string;
  orden: number;
  pos: number;
  /** Clave de unicidad: por defecto (código, campo, objetivo, frase). */
  unico?: string;
  otra?: Hallazgo["otra"];
  ajuste?: AjusteRef | null;
  propuesta?: Hallazgo["propuesta"];
  arreglo?: string;
};

const etiquetaOpcion = <T>(lista: { valor: T; etiqueta: string }[], v: T) => lista.find((o) => o.valor === v)?.etiqueta ?? String(v);
const cortoEntreComillas = (s: string, max = 80) => `«${recortarTexto(s, max)}»`;
function recortarTexto(s: string, max: number): string {
  const c = Array.from(s.replace(/\s+/g, " ").trim());
  return c.length <= max ? c.join("") : `${c.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Horas de pausa como las lee el motor: sin dato (la columna nace en 12) → 12. */
function horasPausa(v: unknown): number {
  if (v == null || (typeof v === "string" && v.trim() === "")) return 12;
  const n = Number(v);
  return Number.isFinite(n) ? n : 12;
}

export function auditarAgente(cfg: ConfigAuditable, ctx: { trasladosActivos?: boolean | null; empresa?: string } = {}): ResultadoAuditoria {
  const aj = normalizarAjustes(cfg?.comportamiento);
  const empresa = typeof ctx.empresa === "string" ? ctx.empresa : "";
  const nombreAgente = str(cfg?.nombre).trim();
  const at: Atencion = atencionDe(aj);
  const atencionUsada = atencionEnUso(at);
  const H = horasPausa(cfg?.pausa_humano_horas);
  const escalarSi = str(cfg?.escalar_si).trim();
  const mensajeDerivacion = str(cfg?.mensaje_derivacion);
  const presentacionAjuste = presentacion(aj, empresa, nombreAgente);
  const { fuentes, titulos } = fuentesDe(cfg ?? {}, aj);

  // ── El ajuste que manda en cada tema, con su valor legible ──
  const ref = (tema: TemaAjusteConAjuste, valorLegible: string, clave?: ClaveAjuste, etiqueta?: string): AjusteRef => ({
    clave: clave ?? TEMAS_AJUSTE[tema].clave,
    etiqueta: etiqueta ?? TEMAS_AJUSTE[tema].etiqueta,
    ancla: TEMAS_AJUSTE[tema].ancla,
    valorLegible,
  });
  const valorHorario = atencionUsada ? describirAtencion(at) : aj.atencion_activa ? "No válido" : "Sin declarar";
  const AJ = {
    tratamiento: ref("tratamiento", etiquetaOpcion(TRATAMIENTOS, aj.tratamiento)),
    preguntas: ref("preguntas", etiquetaOpcion(MODOS_PREGUNTAS, aj.preguntas)),
    resumen: ref("resumen", aj.resumen_pedido ? etiquetaOpcion(RESUMEN_CUANDO, aj.resumen_cuando) : "Resumen apagado"),
    resumenTitulo: ref("resumen", cortoEntreComillas(tituloResumen(aj)), "resumen_titulo", "Título del resumen"),
    resumenPedido: ref("resumen", aj.resumen_pedido ? "Encendido" : "Apagado", "resumen_pedido", "Resumen del pedido"),
    saludo: ref("saludo", aj.menu_saludo ? cortoEntreComillas(aj.menu_saludo, 60) : "Sin menú"),
    presentacion: ref("presentacion", cortoEntreComillas(presentacionAjuste)),
    identidad: ref("identidad_ia", aj.ocultar_ia ? "Marcado" : "Desmarcado"),
    archivos: ref("archivos", aj.leer_archivos ? "Encendido" : "Apagado"),
    audios: ref("audios", aj.transcribir_audios ? "Encendido" : "Apagado"),
    direccion: ref("direccion", aj.lugares_conocidos ? cortoEntreComillas(aj.lugares_conocidos) : "Ninguno"),
    derivacion: ref("derivacion", escalarSi ? cortoEntreComillas(escalarSi) : "Vacío (solo los casos del sistema)"),
    pausa: ref("pausa_humano", H > 0 ? `${H} h` : "0 (la IA no se aparta)"),
    horario: ref("horario", valorHorario),
  };

  const cands: Candidato[] = [];
  const cuentaPorCampo = new Map<string, number>(); // para «hay N frases así»
  const sumar = (k: string) => cuentaPorCampo.set(k, (cuentaPorCampo.get(k) ?? 0) + 1);
  const decls: { campo: CampoTexto; indice?: number; cita: string; orden: number; pos: number; h: DeclHorario }[] = [];

  for (const fu of fuentes) {
    const base = { campo: fu.campo, ...(fu.indice != null ? { indice: fu.indice } : {}), orden: fu.orden };
    const frases = partirFrases(fu.texto);

    for (const f of frases) {
      const n = f.norm;
      const c = (codigo: CodigoCoherencia, extra: Partial<Candidato> = {}) =>
        cands.push({ ...base, codigo, cita: recortarCita(f.texto), pos: f.inicio, ...extra });

      // Trato declarado
      const trato = tratoDeclarado(f);
      if (trato) {
        if (trato === aj.tratamiento) c("tratamiento.duplica", { ajuste: AJ.tratamiento });
        else
          c("tratamiento.contradice", {
            ajuste: AJ.tratamiento,
            propuesta: { clave: "tratamiento", valor: trato, etiqueta: etiquetaOpcion(TRATAMIENTOS, trato) },
            arreglo: `Manda el ajuste «${TEMAS_AJUSTE.tratamiento.etiqueta}»: ${AJ.tratamiento.valorLegible}. Si quieres lo que dice tu texto, pon el ajuste en «${etiquetaOpcion(TRATAMIENTOS, trato)}»; si no, borra la frase.`,
          });
      }

      // Cómo se piden los datos
      const preg = preguntasDeclaradas(f);
      if (preg) {
        if (preg === aj.preguntas) c("preguntas.duplica", { ajuste: AJ.preguntas });
        else
          c("preguntas.contradice", {
            ajuste: AJ.preguntas,
            propuesta: { clave: "preguntas", valor: preg, etiqueta: etiquetaOpcion(MODOS_PREGUNTAS, preg) },
            arreglo: `Manda el ajuste «${TEMAS_AJUSTE.preguntas.etiqueta}»: ${AJ.preguntas.valorLegible}. Si quieres lo que dice tu texto, pon el ajuste en «${etiquetaOpcion(MODOS_PREGUNTAS, preg)}»; si no, borra la frase.`,
          });
      }

      // Resumen: cuándo
      const cuando = resumenCuandoDeclarado(f);
      if (cuando) {
        if (!aj.resumen_pedido) {
          c("resumen.sin_ajuste", { ajuste: AJ.resumenPedido, unico: `resumen.sin_ajuste|${fu.campo}|${fu.indice ?? ""}` });
        } else if (cuando === aj.resumen_cuando) c("resumen.duplica", { ajuste: AJ.resumen });
        else
          c("resumen.contradice", {
            ajuste: AJ.resumen,
            propuesta: { clave: "resumen_cuando", valor: cuando, etiqueta: etiquetaOpcion(RESUMEN_CUANDO, cuando) },
            arreglo: `Manda el ajuste «${TEMAS_AJUSTE.resumen.etiqueta}»: ${AJ.resumen.valorLegible}. Si quieres lo que dice tu texto, pon el ajuste en «${etiquetaOpcion(RESUMEN_CUANDO, cuando)}»; si no, borra la frase.`,
          });
      }

      // Saludo o menú propio
      if (RE_SALUDO.test(n) && RE_SALUDO_ACCION.test(n) && aj.saludo_activo) {
        const unico = `saludo|${fu.campo}|${fu.indice ?? ""}`;
        if (aj.menu_saludo) c("saludo.duplica", { ajuste: AJ.saludo, unico });
        else c("saludo.propio", { ajuste: AJ.saludo, unico });
      }

      // Presentación con nombre propio
      for (const m of f.texto.matchAll(RE_PRESENTACION)) {
        const nombre = m[2];
        const nn = normalizarTexto(nombre);
        if (NO_SON_NOMBRES.has(nn) || nn.length < 2) continue;
        const enAjuste = new RegExp(`\\b${nn.replace(/[^a-z0-9]/g, "")}\\b`).test(normalizarTexto(presentacionAjuste));
        const unico = `presentacion|${fu.campo}|${fu.indice ?? ""}|${nn}`;
        if (enAjuste) c("presentacion.duplica", { ajuste: AJ.presentacion, unico });
        else
          c("presentacion.distinta", {
            ajuste: AJ.presentacion,
            unico,
            arreglo: `El ajuste «${TEMAS_AJUSTE.presentacion.etiqueta}» dice ${AJ.presentacion.valorLegible} y el texto usa «${nombre}». Manda el ajuste. Si el agente se llama ${nombre}, escribe ese nombre en «Nombre del agente» y pon {agente} en «Cómo se presenta» (por ejemplo «{agente}, el asistente de {empresa}»); si no, cambia el nombre del texto.`,
          });
      }

      // Decir que es una IA
      const revela = RE_REVELA.test(n) && !RE_REVELA_NEGADO.test(n) && !RE_PREGUNTA_SI_ES_BOT.test(n);
      const oculta = RE_OCULTA.test(n);
      if (oculta) {
        if (aj.ocultar_ia) c("identidad_ia.duplica", { ajuste: AJ.identidad });
        else c("identidad_ia.sin_ajuste", { ajuste: AJ.identidad });
      } else if (revela && aj.ocultar_ia) c("identidad_ia.contradice", { ajuste: AJ.identidad });

      // Archivos
      if (RE_ANCLA_ARCHIVO.test(n)) {
        const noLee = RE_NO_LEE.test(n), lee = RE_LEE.test(n);
        if (noLee !== lee) {
          const diceLee = lee;
          if (diceLee === aj.leer_archivos) c("archivos.duplica", { ajuste: AJ.archivos });
          else
            c("archivos.contradice", {
              ajuste: AJ.archivos,
              arreglo: aj.leer_archivos
                ? "El ajuste «Leer fotos y PDF» está encendido: la IA lee los archivos y usa sus datos, y esta frase le pide decir que una persona los revisará. Manda el ajuste. Borra esa parte de la frase (deja lo demás, como a qué correo enviar unas bases), o apaga el ajuste si prefieres que la IA no los lea."
                : "El ajuste «Leer fotos y PDF» está apagado: la IA no ve los archivos y dice que un ejecutivo los revisará. Manda el ajuste. Enciéndelo si quieres que los lea, o borra la frase.",
            });
        }
      }

      // Audios
      if (RE_ANCLA_AUDIO.test(n)) {
        const noEscucha = RE_NO_ESCUCHA.test(n), escucha = RE_ESCUCHA.test(n);
        if (noEscucha !== escucha) {
          if (escucha === aj.transcribir_audios) c("audios.duplica", { ajuste: AJ.audios });
          else
            c("audios.contradice", {
              ajuste: AJ.audios,
              arreglo: aj.transcribir_audios
                ? "El ajuste «Escuchar notas de voz» está encendido: la IA lee la nota de voz transcrita y la contesta, y esta frase le pide decir que no puede escucharla. Manda el ajuste. Borra la frase, o apaga el ajuste."
                : "El ajuste «Escuchar notas de voz» está apagado: la IA no escucha los audios y pasa el chat a un ejecutivo. Manda el ajuste. Enciéndelo si quieres que los escuche, o borra la frase.",
            });
        }
      }

      // Dirección exacta
      if (RE_DIRECCION.test(n)) {
        const exime = RE_DIRECCION_EXIME.test(n);
        if (exime && aj.lugares_conocidos) c("direccion.duplica", { ajuste: AJ.direccion });
        else if (!exime && RE_DIRECCION_FUERTE.test(n) && aj.lugares_conocidos)
          c("direccion.contradice", {
            ajuste: AJ.direccion,
            arreglo: `El ajuste «${TEMAS_AJUSTE.direccion.etiqueta}» dice: ${aj.lugares_conocidos}. Ahí manda el ajuste, y el cotizador de traslados cotiza por zona. Agrega a la frase «salvo ${aj.lugares_conocidos}», o bórrala; si también ahí quieres la dirección exacta, vacía el ajuste.`,
          });
      }

      // Pasar a una persona
      if (RE_MOTIVO_DERIVA.test(n) && RE_ACCION_DERIVA.test(n) && !RE_PREGUNTA_SI_ES_BOT.test(n))
        c("derivacion.duplica", {
          ajuste: AJ.derivacion,
          arreglo: `No hace falta cambiarla: el sistema ya pasa el chat a una persona ${MOTIVOS_DERIVACION_SISTEMA}${escalarSi ? `, y si el mensaje menciona: ${escalarSi}` : ""}. Al hacerlo, aparta a la IA de ese chat.`,
        });

      // Pausa cuando contesta una persona
      const mPausa = RE_PAUSA_HORAS.exec(n);
      if (mPausa && RE_PAUSA_QUIEN.test(n) && RE_PAUSA_QUE.test(n)) {
        const N = Number(mPausa[1]);
        if (H > 0 && N === H) c("pausa_humano.duplica", { ajuste: AJ.pausa });
        else
          c("pausa_humano.contradice", {
            ajuste: AJ.pausa,
            arreglo: `Manda el ajuste «${TEMAS_AJUSTE.pausa_humano.etiqueta}»: ${AJ.pausa.valorLegible}; tu texto dice ${N} h. Pon ${N} en el ajuste si es lo que quieres, y borra la frase: la pausa la hace el sistema, la IA no tiene que hacer nada.`,
          });
      }

      // Horario de atención declarado (se compara al final, con todas las declaraciones)
      const h = horarioDeclarado(f);
      if (h) decls.push({ ...base, cita: recortarCita(f.texto), pos: f.inicio, h });
      if ((RE_CIERRE_POR_HORA.test(n) && RE_CIERRE_ACCION.test(n)) || RE_CIERRE_SEGUN_HORA.test(n))
        c("horario.cierres_por_hora", { ajuste: AJ.horario, unico: `cierres|${fu.campo}|${fu.indice ?? ""}` });

      // Seguimiento programado
      const seg = !RE_SEG_NEGADO.test(n) && (
        (RE_SEG_QUE.test(n) && (RE_SEG_CUANDO.test(n) || RE_SEG_SILENCIO.test(n))) ||
        (RE_SEG_SILENCIO.test(n) && RE_SEG_CUANDO.test(n) && RE_SEG_VERBO.test(n)));
      if (seg) {
        const unico = `seguimiento|${fu.campo}|${fu.indice ?? ""}`;
        sumar(unico);
        c("seguimiento.imposible", { ajuste: null, unico });
      }

      // Llamar por teléfono
      if (RE_LLAMADA.test(n) && !RE_LLAMADA_NEGADA.test(n)) c("llamada.imposible", { ajuste: null, unico: `llamada|${fu.campo}|${fu.indice ?? ""}` });

      // Cotizador de traslados (solo si se sabe que está encendido)
      if (ctx.trasladosActivos === true) {
        if (RE_PAX_MUCHOS.test(n) && RE_VARIAS_UNIDADES.test(n)) c("traslados.varias_unidades", { ajuste: null });
        if (RE_URGENCIA_HOY.test(n) && RE_URGENCIA_ACCION.test(n) && !RE_SALVO_TRASLADOS.test(n))
          c("traslados.hoy", { ajuste: null });
      }
    }

    // Plantilla de resumen propia: una por campo (una plantilla son varias líneas), citando su título.
    if (aj.resumen_pedido) {
      const enPlantilla = frases.filter(esPlantillaResumen);
      if (enPlantilla.length) {
        const titulo = frases.find(esTituloResumen);
        const f = titulo ?? enPlantilla[0];
        const igual = titulo && soloPalabras(titulo.texto) === soloPalabras(tituloResumen(aj));
        const sinTituloPropio = !titulo && aj.resumen_titulo !== "";
        cands.push({
          ...base, cita: recortarCita(f.texto), pos: f.inicio, ajuste: AJ.resumenTitulo,
          unico: `resumen.plantilla|${fu.campo}|${fu.indice ?? ""}`,
          ...(igual || sinTituloPropio
            ? { codigo: "resumen.duplica" as const, arreglo: `No hace falta cambiarla: el ajuste «Título del resumen» ya dice ${AJ.resumenTitulo.valorLegible}.` }
            : {
                codigo: "resumen.plantilla_propia" as const,
                arreglo: `El resumen lo arma el ajuste del resumen del pedido, con el título ${AJ.resumenTitulo.valorLegible}. Escribe tu título y tu cierre en «Título del resumen» y «Cierre del resumen» y borra la plantilla de este texto: si no, la IA tendrá dos formatos.`,
              }),
        });
      }
    } else {
      const f = frases.find(esPlantillaResumen);
      if (f) cands.push({ ...base, codigo: "resumen.sin_ajuste", cita: recortarCita(f.texto), pos: f.inicio, ajuste: AJ.resumenPedido, unico: `resumen.sin_ajuste|${fu.campo}|${fu.indice ?? ""}` });
    }

    // Mensajes citados en el otro trato (una por mensaje citado).
    const marca = marcaDelTrato(otroTrato(aj.tratamiento));
    for (const seg of segmentosCitados(fu.texto)) {
      const fr = partirFrases(seg.texto).find((x) => marca.test(x.norm));
      if (fr)
        cands.push({
          ...base, codigo: "tratamiento.plantilla", cita: recortarCita(fr.texto), pos: seg.inicio + fr.inicio, ajuste: AJ.tratamiento,
          unico: `tratamiento.plantilla|${fu.campo}|${fu.indice ?? ""}|${seg.inicio}`,
          arreglo: `El ajuste «${TEMAS_AJUSTE.tratamiento.etiqueta}» dice ${AJ.tratamiento.valorLegible}, y este mensaje está escrito de ${aj.tratamiento === "usted" ? "tú" : "usted"}: si la IA lo copia, el cliente leerá los dos tratos en el mismo chat. Reescríbelo de ${aj.tratamiento === "usted" ? "usted" : "tú"}.`,
        });
    }

    // Saludo propio citado («"Hola, bienvenido a…"»).
    if (aj.saludo_activo)
      for (const seg of segmentosCitados(fu.texto)) {
        if (!RE_INICIO_SALUDO.test(normalizarTexto(seg.texto))) continue;
        const fr = partirFrases(seg.texto)[0];
        const unico = `saludo|${fu.campo}|${fu.indice ?? ""}`;
        cands.push({ ...base, codigo: aj.menu_saludo ? "saludo.duplica" : "saludo.propio", cita: recortarCita(fr.texto), pos: seg.inicio + fr.inicio, ajuste: AJ.saludo, unico });
      }
  }

  // ── El mensaje de derivación propio: es un mensaje al cliente entero ──
  const ordenDeriv = fuentes.length;
  if (mensajeDerivacion.trim()) {
    const frases = partirFrases(mensajeDerivacion);
    const marca = marcaDelTrato(otroTrato(aj.tratamiento));
    const fr = frases.find((x) => marca.test(x.norm));
    if (fr)
      cands.push({
        campo: "mensaje_derivacion", orden: ordenDeriv, codigo: "tratamiento.plantilla", cita: recortarCita(fr.texto), pos: fr.inicio, ajuste: AJ.tratamiento,
        arreglo: `El ajuste «${TEMAS_AJUSTE.tratamiento.etiqueta}» dice ${AJ.tratamiento.valorLegible}, y el mensaje de derivación está escrito de ${aj.tratamiento === "usted" ? "tú" : "usted"}. Reescríbelo de ${aj.tratamiento === "usted" ? "usted" : "tú"}, o déjalo vacío: el mensaje por defecto sigue el trato del ajuste.`,
      });
    for (const f of frases) {
      const h = horarioDeclarado(f);
      if (h) decls.push({ campo: "mensaje_derivacion", orden: ordenDeriv, cita: recortarCita(f.texto), pos: f.inicio, h });
    }
    if (atencionUsada && !mensajeDerivacion.includes("{atencion}"))
      cands.push({ campo: "mensaje_derivacion", orden: ordenDeriv, codigo: "horario.derivacion_sin_atencion", cita: recortarCita(frases[0]?.texto ?? mensajeDerivacion), pos: 0, ajuste: AJ.horario });
  }

  // ── Horario de atención: contra el ajuste en uso, o texto contra texto ──
  if (aj.atencion_activa && !atencionValida(at)) {
    const prob = problemaAtencion(at);
    cands.push({
      campo: null, orden: Number.MAX_SAFE_INTEGER, codigo: "horario.invalido", cita: describirAtencion(at), pos: 0, ajuste: AJ.horario,
      etiquetaCampo: `${TEMAS_AJUSTE.horario.etiqueta} (ajuste)`,
      arreglo: prob ? `${PROBLEMA_ATENCION[prob]} Corrígelo en «${TEMAS_AJUSTE.horario.etiqueta}».` : TABLA["horario.invalido"].arreglo,
    });
  }
  if (atencionUsada) {
    const ajusteH: DeclHorario = { desde: at.desde, hasta: at.hasta, dias: [...at.dias] };
    for (const d of decls) {
      const unico = `horario|${d.campo}|${d.indice ?? ""}|${claveHorario(d.h)}`;
      if (mismoHorario(d.h, ajusteH)) cands.push({ ...d, codigo: "horario.duplica", ajuste: AJ.horario, unico });
      else
        cands.push({
          ...d, codigo: "horario.contradice", ajuste: AJ.horario, unico,
          arreglo: `El ajuste «${TEMAS_AJUSTE.horario.etiqueta}» dice ${describirAtencion(at)}; el texto dice ${describirDecl(d.h)}. Manda el ajuste. Corrige la frase o el ajuste para que digan lo mismo.`,
        });
    }
  } else if (decls.length) {
    // Texto contra texto: un choque por par de horarios distintos (citando la primera frase de cada uno).
    const grupos: (typeof decls)[number][] = [];
    for (const d of decls) if (!grupos.some((g) => mismoHorario(g.h, d.h))) grupos.push(d);
    for (let i = 0; i < grupos.length; i++)
      for (let j = i + 1; j < grupos.length; j++) {
        const a = grupos[i], b = grupos[j];
        cands.push({
          ...a, codigo: "horario.textos_chocan", ajuste: AJ.horario, unico: `${claveHorario(a.h)}|${claveHorario(b.h)}`,
          otra: { campo: b.campo, etiquetaCampo: etiquetaDe(b.campo, b.indice, titulos), cita: b.cita, ...(b.indice != null ? { indice: b.indice } : {}) },
          arreglo: `«${etiquetaDe(a.campo, a.indice, titulos)}» dice ${describirDecl(a.h)} y «${etiquetaDe(b.campo, b.indice, titulos)}» dice ${describirDecl(b.h)}. Declara el horario correcto en el ajuste «${TEMAS_AJUSTE.horario.etiqueta}» y corrige o borra las frases que digan otro.`,
        });
      }
    const p = decls[0];
    cands.push({
      ...p, codigo: "horario.sin_ajuste", ajuste: AJ.horario, unico: "horario.sin_ajuste",
      arreglo: `Declara el horario en el ajuste «${TEMAS_AJUSTE.horario.etiqueta}» (${aj.atencion_activa ? "hoy no es válido" : "hoy está sin declarar"}): así la IA y el mensaje de derivación dirán cuándo responde una persona fuera de ese horario.`,
    });
  }

  // ── Choques entre ajustes ──
  if (/\{agente\}/.test(aj.presentarse_como) && !nombreAgente)
    cands.push({
      campo: null, orden: Number.MAX_SAFE_INTEGER, codigo: "presentacion.sin_nombre", cita: aj.presentarse_como, pos: 0, ajuste: AJ.presentacion,
      etiquetaCampo: `${TEMAS_AJUSTE.presentacion.etiqueta} (ajuste)`,
    });
  if (aj.ocultar_ia && RE_VIRTUAL_EN_AJUSTE.test(normalizarTexto(aj.presentarse_como)))
    cands.push({
      campo: null, orden: Number.MAX_SAFE_INTEGER, codigo: "identidad_ia.ajustes_chocan", cita: aj.presentarse_como, pos: 0, ajuste: AJ.identidad,
      etiquetaCampo: `${TEMAS_AJUSTE.presentacion.etiqueta} (ajuste)`,
    });

  // ── Un hallazgo por (código, campo, frase), o por la unidad que declare el candidato ──
  const vistos = new Set<string>();
  const hallazgos: Hallazgo[] = [];
  const ordenados = [...cands].sort((a, b) => a.orden - b.orden || a.pos - b.pos);
  for (const k of ordenados) {
    const unico = k.unico ?? `${k.codigo}|${k.campo ?? ""}|${k.indice ?? ""}|${k.cita}`;
    const llave = k.unico ? `${k.codigo}|${unico}` : unico;
    if (vistos.has(llave)) continue;
    vistos.add(llave);
    const fila = TABLA[k.codigo];
    let arreglo = k.arreglo ?? fila.arreglo;
    if (k.codigo === "seguimiento.imposible") {
      const n = cuentaPorCampo.get(unico) ?? 1;
      if (n > 1) arreglo = `${fila.arreglo} En este campo hay ${n} frases así: bórralas todas.`;
    }
    hallazgos.push({
      codigo: k.codigo,
      tema: k.codigo.split(".")[0] as TemaAjuste,
      relacion: fila.relacion,
      alarma: fila.alarma,
      campo: k.campo,
      ...(k.indice != null ? { indice: k.indice } : {}),
      etiquetaCampo: k.etiquetaCampo ?? (k.campo ? etiquetaDe(k.campo, k.indice, titulos) : ""),
      cita: k.cita,
      ...(k.otra ? { otra: k.otra } : {}),
      ajuste: k.ajuste ?? null,
      ...(k.propuesta ? { propuesta: k.propuesta } : {}),
      titulo: fila.titulo,
      arreglo,
    });
  }

  // Orden: alarmas primero, después tema, campo y posición.
  const posTema = (t: TemaAjuste) => TEMAS_COHERENCIA.indexOf(t);
  const posCampo = (c: CampoTexto | null) => (c == null ? CAMPOS_TEXTO.length : CAMPOS_TEXTO.indexOf(c));
  const posDe = new Map(hallazgos.map((h, i) => [h, i]));
  hallazgos.sort((a, b) =>
    Number(b.alarma) - Number(a.alarma) ||
    posTema(a.tema) - posTema(b.tema) ||
    posCampo(a.campo) - posCampo(b.campo) ||
    (a.indice ?? 0) - (b.indice ?? 0) ||
    posDe.get(a)! - posDe.get(b)!,
  );

  const porTema: Partial<Record<TemaAjuste, number>> = {};
  const porCampo: Record<string, number> = {};
  for (const h of hallazgos) {
    if (!h.alarma) continue;
    porTema[h.tema] = (porTema[h.tema] ?? 0) + 1;
    const campos = [h.campo ?? "ajustes", ...(h.otra && h.otra.campo !== h.campo ? [h.otra.campo] : [])];
    for (const c of campos) porCampo[c] = (porCampo[c] ?? 0) + 1;
  }
  const alarmas = hallazgos.filter((h) => h.alarma).length;
  return { hallazgos, alarmas, grises: hallazgos.length - alarmas, porTema, porCampo };
}

/** La identidad de un hallazgo: (código, campo, objetivo, frase; y la otra frase en `textos_chocan`).
 *  Editar la frase da otro hallazgo. */
export const claveHallazgo = (h: Hallazgo): string =>
  `${h.codigo}|${h.campo ?? ""}|${h.indice ?? ""}|${h.cita}${h.otra ? `|${h.otra.campo}|${h.otra.cita}` : ""}`;

/** Las alarmas de `despues` que no estaban en `antes`: lo que una edición AGREGA (para el confirm()
 *  de guardar; las que ya estaban no se vuelven a preguntar). */
export function nuevasAlarmas(antes: Hallazgo[], despues: Hallazgo[]): Hallazgo[] {
  const ya = new Set(antes.filter((h) => h.alarma).map(claveHallazgo));
  return despues.filter((h) => h.alarma && !ya.has(claveHallazgo(h)));
}
