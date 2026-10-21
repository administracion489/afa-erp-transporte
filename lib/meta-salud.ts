// lib/meta-salud.ts — PURO (no lee la base ni la red).
//
// ¿POR QUÉ Meta no deja enviar por un número? Lo dice la propia Meta, y el ERP no se
// lo preguntaba.
//
// EL CASO (20-10-2026): desde las 13:18-15:32 cada envío del CRM por el
// +51 966 707 225 salía con «(#131005) Access denied», con el token propio del número
// Y con el general de la empresa, mientras el número de avisos enviaba, las fotos del
// cliente se descargaban y lo escrito desde el celular salía. La pregunta del dueño
// fue «¿será porque tengo deuda?», y con «Access denied» solo no hay forma de
// contestarla: el código es el mismo para un permiso retirado que para una cuenta
// bloqueada.
//
// Meta publica la respuesta en dos sitios, y aquí se leen los dos:
//   1. `GET /{phone_number_id}?fields=health_status` — si el número PUEDE enviar
//      (AVAILABLE · LIMITED · BLOCKED) y, si no, QUÉ lo bloquea, por entidad (el
//      número, la cuenta de WhatsApp, el portafolio de negocio, la app), con el
//      motivo y la solución que escribe Meta. Un problema de pago sale aquí.
//   2. `GET /debug_token` — si el token sigue siendo válido y si tiene el permiso de
//      mensajería (`whatsapp_business_messaging`) sobre ESA cuenta de WhatsApp.
//
// El veredicto va de la evidencia al juicio y nunca afirma lo que no leyó: sin
// respuesta de Meta dice «no se pudo consultar», no «está bien».

/** Separa, dentro del error de un envío, el código de Meta de su diagnóstico. */
export const MARCA_META_DICE = " · Meta dice: ";

export type NivelEnvio = "AVAILABLE" | "LIMITED" | "BLOCKED";

export type Bloqueo = {
  entidad: string; // PHONE_NUMBER · WABA · BUSINESS · APP (lo que diga Meta)
  id: string | null;
  nivel: NivelEnvio | null;
  codigo: number | null;
  descripcion: string;
  solucion: string | null;
};

export type SaludLeida = {
  /** null = no se pudo leer (error de Meta o respuesta sin `health_status`). */
  nivel: NivelEnvio | null;
  bloqueos: Bloqueo[];
  error: string | null;
};

export type PermisoLeido = {
  /** null = no se pudo leer. */
  valido: boolean | null;
  /** ¿Tiene `whatsapp_business_messaging` sobre la cuenta? null = no se sabe. */
  mensajeria: boolean | null;
  error: string | null;
};

export type LecturaToken = { cual: "propio" | "general"; salud: SaludLeida | null; permisos: PermisoLeido | null };

export type CodigoVeredicto = "pago" | "bloqueo_meta" | "token_invalido" | "sin_permiso" | "disponible" | "no_se_sabe";

export type Veredicto = { codigo: CodigoVeredicto; texto: string };

export const NOMBRE_ENTIDAD: Record<string, string> = {
  PHONE_NUMBER: "el número",
  WABA: "la cuenta de WhatsApp (WABA)",
  BUSINESS: "el portafolio de negocio de Meta",
  APP: "la app del ERP en Meta",
};

function nivelDe(v: unknown): NivelEnvio | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "AVAILABLE" || s === "LIMITED" || s === "BLOCKED" ? s : null;
}

function errorDeGraph(data: any, status: number): string | null {
  const e = data?.error;
  if (!e) return status >= 400 ? `HTTP ${status}` : null;
  const code = e.code != null && e.code !== "" ? ` (código ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : "";
  return `${String(e.message ?? "Error de Meta")}${code}`;
}

const texto = (v: unknown, max = 300): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Lee la respuesta de `GET /{phone_number_id}?fields=health_status`. */
export function leerSalud(status: number, data: any): SaludLeida {
  const error = errorDeGraph(data, status);
  const hs = data?.health_status;
  if (error || !hs || typeof hs !== "object") {
    return { nivel: null, bloqueos: [], error: error ?? "Meta no devolvió health_status." };
  }
  const bloqueos: Bloqueo[] = [];
  for (const e of Array.isArray(hs.entities) ? hs.entities : []) {
    const entidad = texto(e?.entity_type, 40) || "DESCONOCIDA";
    const nivel = nivelDe(e?.can_send_message);
    const id = e?.id != null ? String(e.id) : null;
    const errores = Array.isArray(e?.errors) ? e.errors : [];
    for (const er of errores) {
      const c = Number(er?.error_code);
      bloqueos.push({
        entidad,
        id,
        nivel,
        codigo: Number.isFinite(c) ? c : null,
        descripcion: texto(er?.error_description) || "sin descripción",
        solucion: texto(er?.possible_solution) || null,
      });
    }
    // Una entidad que no puede enviar y no dice por qué también se nombra.
    if (!errores.length && nivel && nivel !== "AVAILABLE") {
      const extra = Array.isArray(e?.additional_info) ? e.additional_info.map((x: unknown) => texto(x)).filter(Boolean).join(" ") : "";
      bloqueos.push({ entidad, id, nivel, codigo: null, descripcion: extra || `estado ${nivel}, sin detalle`, solucion: null });
    }
  }
  return { nivel: nivelDe(hs.can_send_message), bloqueos, error: null };
}

/** Lee la respuesta de `GET /debug_token`, juzgando el permiso sobre `wabaId`. */
export function leerPermisos(status: number, data: any, wabaId: string | null): PermisoLeido {
  const d = data?.data;
  if (!d || typeof d !== "object") {
    return { valido: null, mensajeria: null, error: errorDeGraph(data, status) ?? "Meta no devolvió los datos del token." };
  }
  const valido = d.is_valid === true ? true : d.is_valid === false ? false : null;
  const errToken = d.error ? texto(d.error.message ?? d.error) : null;
  const granulares: any[] = Array.isArray(d.granular_scopes) ? d.granular_scopes : [];
  const scopes: string[] = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
  const g = granulares.find((x) => x?.scope === "whatsapp_business_messaging");
  let mensajeria: boolean | null;
  if (g) {
    const destinos = Array.isArray(g.target_ids) ? g.target_ids.map(String) : null;
    // Sin `target_ids` el permiso no está acotado a ninguna cuenta: vale para todas.
    mensajeria = destinos == null ? true : wabaId ? destinos.includes(String(wabaId)) : null;
  } else {
    mensajeria = scopes.includes("whatsapp_business_messaging") ? (wabaId ? null : true) : granulares.length || scopes.length ? false : null;
  }
  return { valido, mensajeria, error: errToken };
}

const PAGO = /payment|billing|credit\s*line|line of credit|invoice|pago|factura|cr[eé]dito|tarjeta/i;

/** ¿El bloqueo es por dinero (método de pago, línea de crédito, factura)? */
export function esDePago(b: Bloqueo): boolean {
  return PAGO.test(`${b.descripcion} ${b.solucion ?? ""}`);
}

function frase(b: Bloqueo): string {
  const quien = NOMBRE_ENTIDAD[b.entidad] ?? b.entidad;
  const cod = b.codigo != null ? ` [${b.codigo}]` : "";
  return `${quien}${b.id ? ` ${b.id}` : ""}: ${b.descripcion}${cod}${b.solucion ? ` — Solución de Meta: ${b.solucion}` : ""}`;
}

const NOMBRE_TOKEN = { propio: "el acceso propio del número", general: "el acceso general de la empresa (META_WA_TOKEN)" } as const;

/**
 * El veredicto, de la evidencia al juicio: (1) lo que Meta dice que bloquea el
 * número —con el pago aparte, porque se arregla en otro sitio—; (2) un token
 * caducado; (3) el permiso de mensajería que falta; (4) Meta dice que el número
 * puede enviar; (5) no se pudo saber.
 */
export function veredictoSalud(lecturas: LecturaToken[], wabaId: string | null): Veredicto {
  const vistos = new Set<string>();
  const bloqueos: Bloqueo[] = [];
  for (const l of lecturas) {
    for (const b of l.salud?.bloqueos ?? []) {
      const k = `${b.entidad}|${b.codigo}|${b.descripcion}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      bloqueos.push(b);
    }
  }
  const pago = bloqueos.filter(esDePago);
  if (pago.length) {
    return { codigo: "pago", texto: `Meta bloquea el envío por un tema de PAGO en ${pago.map(frase).join(" · ")}` };
  }
  if (bloqueos.length) {
    return { codigo: "bloqueo_meta", texto: `Meta bloquea el envío en ${bloqueos.map(frase).join(" · ")}` };
  }

  const invalidos = lecturas.filter((l) => l.permisos?.valido === false);
  if (invalidos.length && invalidos.length === lecturas.filter((l) => l.permisos).length) {
    return {
      codigo: "token_invalido",
      texto: `Meta dice que ${invalidos.map((l) => NOMBRE_TOKEN[l.cual]).join(" y ")} ya no es válido${invalidos.length > 1 ? "s" : ""}${invalidos[0].permisos?.error ? ` (${invalidos[0].permisos.error})` : ""}.`,
    };
  }

  const conPermisoLeido = lecturas.filter((l) => l.permisos?.mensajeria != null);
  if (conPermisoLeido.length && conPermisoLeido.every((l) => l.permisos!.mensajeria === false)) {
    return {
      codigo: "sin_permiso",
      texto: `Ni ${conPermisoLeido.map((l) => NOMBRE_TOKEN[l.cual]).join(" ni ")} tienen el permiso de mensajería (whatsapp_business_messaging) sobre la cuenta de WhatsApp${wabaId ? ` ${wabaId}` : ""}: la app del ERP perdió el acceso a esa cuenta.`,
    };
  }

  const disponibles = lecturas.filter((l) => l.salud?.nivel === "AVAILABLE");
  if (disponibles.length) {
    return {
      codigo: "disponible",
      texto: `Meta dice que el número SÍ puede enviar (estado AVAILABLE, sin bloqueos ni deudas) y aun así rechaza el envío del ERP: es un permiso de la app sobre la cuenta${wabaId ? ` ${wabaId}` : ""}, no un pago.`,
    };
  }

  const errores = lecturas.map((l) => l.salud?.error ?? l.permisos?.error).filter(Boolean);
  return { codigo: "no_se_sabe", texto: `No se pudo consultar a Meta el estado del número${errores.length ? ` (${errores[0]})` : ""}.` };
}
