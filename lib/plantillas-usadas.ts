// lib/plantillas-usadas.ts — ¿Qué plantillas de WhatsApp usa el ERP, y cuáles faltan en Meta?
// Módulo PURO: recibe las tarjetas de `alerta_config` y la lista de la cuenta de avisos, y no lee
// nada por su cuenta.
//
// POR QUÉ EXISTE (revisión del 13-10-2026): una tarjeta puede decir «Activo» y no mandar nada
// porque su plantilla NO EXISTE en Meta (#132001). Pasó el 11-10-2026 con tres plantillas de la
// escalera de inicio, y este documento afirmaba que salían. La prueba de verdad es el envío, pero un
// aviso que sale una vez al mes (una cancelación, un documento por vencer) no se prueba solo: esta
// lista lo dice ANTES, comparando lo que el código manda con lo que la cuenta tiene.

/** Plantillas que el código manda por su nombre, sin pasar por una tarjeta. */
export const PLANTILLAS_FIJAS: { nombre: string; uso: string }[] = [
  { nombre: "recordatorio_servicio", uso: "Aviso del servicio al pasajero (recordatorio y aviso manual)" },
  { nombre: "bus_llego_paradero", uso: "«El bus llegó» al pasajero" },
  { nombre: "recordatorio_conductor_completo", uso: "Recordatorio al conductor con ida y retorno en un solo mensaje" },
  { nombre: "conductor_asignacion_multiple", uso: "Varias asignaciones al conductor en un solo mensaje" },
  { nombre: "invitacion_app_pasajero", uso: "Invitación al pasajero a instalar la app" },
  { nombre: "documentos_proveedor_vencer", uso: "Documentos por vencer al proveedor tercerizado" },
  { nombre: "liquidacion_conformidad", uso: "Liquidación enviada al cliente para su conformidad" },
];

export type TarjetaUso = {
  clave: string;
  nombre: string;
  activo: boolean;
  plantilla: string | null;
  plantilla_directorio?: string | null;
  destinatarios: number[];
  /** Si la tarjeta de verdad le escribe al directorio (lo decide quien llama). */
  escribeAlDirectorio: boolean;
};

export type PlantillaUsada = { nombre: string; usos: string[]; activa: boolean };

/** La plantilla del directorio de una tarjeta: la suya o, sin ella, la genérica (igual que el tick). */
export const PLANTILLA_DIRECTORIO_DEFECTO = "coordinador_alerta";

/** Todas las plantillas que el ERP manda, con quién las usa. `activa` = alguna tarjeta encendida (o fija). */
export function plantillasQueUsa(tarjetas: TarjetaUso[]): PlantillaUsada[] {
  const m = new Map<string, PlantillaUsada>();
  const sumar = (nombre: string | null | undefined, uso: string, activa: boolean) => {
    const n = String(nombre ?? "").trim();
    if (!n) return;
    const e = m.get(n) ?? { nombre: n, usos: [], activa: false };
    if (!e.usos.includes(uso)) e.usos.push(uso);
    e.activa = e.activa || activa;
    m.set(n, e);
  };
  for (const t of tarjetas) {
    sumar(t.plantilla, `Tarjeta «${t.nombre}»`, t.activo);
    if (t.escribeAlDirectorio && t.destinatarios.length > 0) {
      sumar(t.plantilla_directorio || PLANTILLA_DIRECTORIO_DEFECTO, `Tarjeta «${t.nombre}» (al directorio)`, t.activo);
      // «Recordar llamar al conductor» con varios servicios a la vez va en UN mensaje genérico.
      if (t.clave === "llamar_conductor") sumar(PLANTILLA_DIRECTORIO_DEFECTO, `Tarjeta «${t.nombre}» (varios a la vez)`, t.activo);
    }
  }
  for (const f of PLANTILLAS_FIJAS) sumar(f.nombre, f.uso, true);
  return [...m.values()];
}

export type EstadoEnMeta = "aprobada" | "en_revision" | "rechazada" | "no_existe";

/**
 * El estado de una plantilla en la cuenta de avisos. Basta con UNA traducción aprobada en cualquier
 * idioma: `lib/plantilla-idioma.ts` reintenta en ese idioma cuando «es» no existe.
 */
export function estadoEnMeta(nombre: string, meta: { name: string; status: string }[]): EstadoEnMeta {
  const filas = meta.filter((t) => t.name === nombre);
  if (filas.length === 0) return "no_existe";
  const st = filas.map((t) => String(t.status).toUpperCase());
  if (st.includes("APPROVED")) return "aprobada";
  if (st.some((x) => x === "PENDING" || x === "IN_APPEAL" || x === "PENDING_DELETION")) return "en_revision";
  return "rechazada";
}

export const TEXTO_ESTADO: Record<EstadoEnMeta, string> = {
  aprobada: "Aprobada",
  en_revision: "En revisión: no sale hasta que Meta la apruebe",
  rechazada: "Rechazada o pausada en Meta: no sale",
  no_existe: "No existe en la cuenta de avisos: ese aviso no sale",
};

/** Ordenadas por urgencia: lo que falta y está encendido primero; lo aprobado al final. */
export function revisarPlantillas(usadas: PlantillaUsada[], meta: { name: string; status: string }[]) {
  const peso: Record<EstadoEnMeta, number> = { no_existe: 0, rechazada: 1, en_revision: 2, aprobada: 3 };
  return usadas
    .map((u) => ({ ...u, estado: estadoEnMeta(u.nombre, meta) }))
    .sort((a, b) => peso[a.estado] - peso[b.estado]
      || (a.activa === b.activa ? 0 : a.activa ? -1 : 1)
      || a.nombre.localeCompare(b.nombre));
}
