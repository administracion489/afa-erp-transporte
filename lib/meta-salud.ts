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
//   3. `GET /{phone_number_id}?fields=status,name_status,platform_type,…` y
//      `GET /{waba_id}/phone_numbers` — si el número sigue activo en la Cloud API y
//      si sigue dentro de la cuenta de WhatsApp que el ERP tiene registrada.
//
// El veredicto va de la evidencia al juicio y nunca afirma lo que no leyó: sin
// respuesta de Meta dice «no se pudo consultar», no «está bien».
//
// LO QUE CONTESTÓ META LA PRIMERA VEZ (20-10-2026, 22:52) y por qué se separan las
// LLAMADAS: el número salía LIMITED por tres motivos, dos de ellos de WhatsApp
// Business CALLING (138024 y 138025: «no hay servidor SIP configurado»), que no
// tienen nada que ver con los mensajes y que el ERP no usa. Ponerlos en el titular
// mandaba a configurar un SIP. Se conservan en la lectura guardada y no entran al
// veredicto. El tercero era la verificación del negocio (141010), y tiene su propio
// código porque se arregla en otro sitio y no es una deuda.
//
// Y LO QUE health_status NO DICE: EL MÉTODO DE PAGO. El 21-10-2026 WhatsApp
// Manager mostraba «Falta un método de pago válido: no podrás enviar mensajes a los
// clientes hasta que agregues un método de pago», y health_status no lo mencionaba:
// el veredicto decía «Meta no marca ningún problema de pago», que era falso. Por eso
// se lee además la CUENTA de WhatsApp (`GET /{waba_id}?fields=currency,
// primary_funding_id,…`): sin `primary_funding_id` no hay método de pago y eso
// manda sobre todo lo demás. «No es un pago» solo se afirma cuando la cuenta se leyó
// y TIENE método de pago; si no se pudo leer, se dice dónde mirarlo.

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

/** El estado del número que publica Meta (null = no se pudo leer o no vino). */
export type NumeroLeido = {
  status: string | null;
  nombre: string | null; // name_status
  plataforma: string | null; // platform_type
  modo: string | null; // account_mode
  calidad: string | null; // quality_rating
  /** ¿El número figura en la cuenta de WhatsApp que el ERP tiene registrada? null = no se sabe. */
  enWaba: boolean | null;
  error: string | null;
};

/** La cuenta de WhatsApp (WABA): moneda, método de pago y revisión. */
export type CuentaLeida = {
  moneda: string | null;
  /** ¿Tiene método de pago (primary_funding_id)? null = no se pudo leer. */
  metodoPago: boolean | null;
  revision: string | null; // account_review_status
  error: string | null;
};

export type LecturaToken = {
  cual: "propio" | "general";
  salud: SaludLeida | null;
  permisos: PermisoLeido | null;
  /** Opcionales: las lecturas guardadas antes de estas piezas no los traen. */
  numero?: NumeroLeido | null;
  cuenta?: CuentaLeida | null;
};

export type CodigoVeredicto =
  | "pago"
  | "bloqueo_meta"
  | "token_invalido"
  | "sin_permiso"
  | "otra_cuenta"
  | "numero_estado"
  | "verificacion"
  | "disponible"
  | "no_se_sabe";

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

const txt = (v: unknown): string | null => {
  const t = texto(v, 60);
  return t ? t.toUpperCase() : null;
};

/**
 * Lee `GET /{phone_number_id}?fields=status,name_status,platform_type,account_mode,quality_rating`
 * y, aparte, la lista de números de la cuenta de WhatsApp (`GET /{waba_id}/phone_numbers`).
 * `lista` null = no se pidió o no se pudo leer.
 */
export function leerNumero(
  status: number,
  data: any,
  phoneId: string,
  lista: { status: number; data: any } | null,
): NumeroLeido {
  const error = errorDeGraph(data, status);
  let enWaba: boolean | null = null;
  if (lista && !errorDeGraph(lista.data, lista.status) && Array.isArray(lista.data?.data)) {
    const ids = lista.data.data.map((x: any) => String(x?.id ?? ""));
    if (ids.includes(String(phoneId))) enWaba = true;
    // Sin el número y con más páginas no se afirma nada: puede estar en la siguiente.
    else if (!lista.data?.paging?.next) enWaba = false;
  }
  if (error) return { status: null, nombre: null, plataforma: null, modo: null, calidad: null, enWaba, error };
  return {
    status: txt(data?.status),
    nombre: txt(data?.name_status),
    plataforma: txt(data?.platform_type),
    modo: txt(data?.account_mode),
    calidad: txt(data?.quality_rating),
    enWaba,
    error: null,
  };
}

/**
 * Lee `GET /{waba_id}?fields=id,currency,primary_funding_id,account_review_status`.
 * Graph omite los campos vacíos, así que sin `primary_funding_id` en una respuesta
 * que sí trae la cuenta (`id`) no hay método de pago. Con error, nada se afirma.
 */
export function leerCuenta(status: number, data: any): CuentaLeida {
  const error = errorDeGraph(data, status);
  if (error || !data || typeof data !== "object" || data.id == null) {
    return { moneda: null, metodoPago: null, revision: null, error: error ?? "Meta no devolvió la cuenta de WhatsApp." };
  }
  const fondo = data.primary_funding_id;
  return {
    moneda: txt(data.currency),
    metodoPago: fondo != null && String(fondo).trim() !== "",
    revision: txt(data.account_review_status),
    error: null,
  };
}

/**
 * ¿La cuenta no se pudo leer porque Meta reserva el método de pago a los proveedores
 * BSP? Se mira el TEXTO del error, no un campo nuevo, para que también lo reconozcan
 * las lecturas ya guardadas en `crm_config`.
 */
export function cuentaSoloParaBsp(c: CuentaLeida | null | undefined): boolean {
  return !!c?.error && /business solution provider/i.test(c.error);
}

/** Estados del número que Meta documenta como «no puede operar». Los demás no se juzgan. */
const ESTADOS_MALOS = new Set(["DISCONNECTED", "FLAGGED", "RESTRICTED", "BANNED", "DELETED", "RATE_LIMITED"]);

/** Lo que el estado del número dice que impide enviar, o null si no dice nada. */
export function problemaNumero(n: NumeroLeido | null | undefined): string | null {
  if (!n || n.error) return null;
  if (n.status && ESTADOS_MALOS.has(n.status)) return `Meta tiene el número en estado ${n.status}`;
  if (n.plataforma && n.plataforma !== "CLOUD_API")
    return `Meta dice que el número no está activo en la Cloud API (platform_type ${n.plataforma})`;
  if (n.nombre === "DECLINED" || n.nombre === "EXPIRED")
    return `Meta ${n.nombre === "DECLINED" ? "rechazó" : "dio por vencido"} el nombre visible del número (name_status ${n.nombre})`;
  return null;
}

/**
 * ¿El bloqueo es de WhatsApp Business CALLING (llamadas)? Son los 138xxx y los que
 * hablan de SIP o de calling. No afectan a los mensajes: se guardan y no se juzgan.
 */
export function esDeLlamadas(b: Bloqueo): boolean {
  if (b.codigo != null && b.codigo >= 138000 && b.codigo < 139000) return true;
  return /\bSIP\b|\bcalling\b|\bllamadas?\b/i.test(`${b.descripcion} ${b.solucion ?? ""}`);
}

/** ¿El bloqueo es la verificación del negocio (141010)? */
export function esDeVerificacion(b: Bloqueo): boolean {
  if (b.codigo === 141010) return true;
  return /business verification|verificaci[oó]n del? negocio/i.test(`${b.descripcion} ${b.solucion ?? ""}`);
}

/** Lo que Meta escribe en inglés para los códigos que ya se conocen, dicho en castellano. */
const EN_CASTELLANO: Record<number, { descripcion: string; solucion: string }> = {
  141010: {
    descripcion: "no ha pasado la verificación de negocio de Meta",
    solucion: "iniciar o resolver la verificación en Meta Business Suite → Configuración del negocio → Centro de seguridad",
  },
};

const PAGO = /payment|billing|credit\s*line|line of credit|invoice|pago|factura|cr[eé]dito|tarjeta/i;

/** ¿El bloqueo es por dinero (método de pago, línea de crédito, factura)? */
export function esDePago(b: Bloqueo): boolean {
  return PAGO.test(`${b.descripcion} ${b.solucion ?? ""}`);
}

function frase(b: Bloqueo): string {
  const quien = NOMBRE_ENTIDAD[b.entidad] ?? b.entidad;
  const cod = b.codigo != null ? ` [${b.codigo}]` : "";
  const es = b.codigo != null ? EN_CASTELLANO[b.codigo] : undefined;
  const descripcion = es?.descripcion ?? b.descripcion;
  const solucion = es?.solucion ?? b.solucion;
  return `${quien}${b.id ? ` ${b.id}` : ""}: ${descripcion}${cod}${solucion ? ` — Solución de Meta: ${solucion}` : ""}`;
}

const NOMBRE_TOKEN = { propio: "el acceso propio del número", general: "el acceso general de la empresa (META_WA_TOKEN)" } as const;

/**
 * El veredicto, de la evidencia al juicio: (0) la cuenta sin método de pago; (1) lo
 * que Meta dice que bloquea el número —el pago aparte, porque se arregla en otro sitio, y sin lo de las llamadas,
 * que no toca los mensajes—; (2) un token caducado; (3) el permiso de mensajería que
 * falta; (4) el número fuera de la cuenta registrada; (5) el número inactivo en la
 * Cloud API; (6) la verificación del negocio; (7) Meta dice que el número puede
 * enviar; (8) no se pudo saber. Lo que Meta marca y no es lo que decide el veredicto
 * se agrega al final: nada de lo que dijo se calla, salvo las llamadas.
 */
export function veredictoSalud(lecturas: LecturaToken[], wabaId: string | null): Veredicto {
  const vistos = new Set<string>();
  const bloqueos: Bloqueo[] = [];
  for (const l of lecturas) {
    for (const b of l.salud?.bloqueos ?? []) {
      if (esDeLlamadas(b)) continue;
      const k = `${b.entidad}|${b.codigo}|${b.descripcion}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      bloqueos.push(b);
    }
  }
  const pago = bloqueos.filter(esDePago);
  const verif = bloqueos.filter((b) => !esDePago(b) && esDeVerificacion(b));
  const resto = bloqueos.filter((b) => !esDePago(b) && !esDeVerificacion(b));
  const cuenta = wabaId ? ` ${wabaId}` : "";
  // La pregunta que abrió este módulo fue «¿es por deuda?». health_status NO ve el
  // método de pago (el 21-10-2026 faltaba y no lo decía), así que «no es un pago»
  // solo se afirma con la cuenta leída y con método de pago. Si no se pudo leer, se
  // dice dónde mirarlo en vez de afirmar nada.
  const cuentas = lecturas.map((l) => l.cuenta).filter((c): c is CuentaLeida => !!c && !c.error);
  const sinMetodo = cuentas.find((c) => c.metodoPago === false);
  const conMetodo = cuentas.some((c) => c.metodoPago === true);
  // Meta solo le deja leer el método de pago a un proveedor BSP de WhatsApp: a un
  // Tech Provider (AFA desde ago-2026) le contesta (#10) «requires that the Business
  // that owns this App is a Business Solution Provider». Visto el 20-10-2026 con la
  // cuenta recién pagada: el ERP no PUEDE saberlo, y lo dice en vez de callarlo.
  const soloBsp = !cuentas.length && lecturas.some((l) => cuentaSoloParaBsp(l.cuenta));
  const sinPago = conMetodo
    ? " La cuenta tiene método de pago: no es un tema de pago."
    : soloBsp
      ? " El ERP no puede comprobar el método de pago: Meta solo se lo muestra a un proveedor BSP de WhatsApp. Revísalo en WhatsApp Manager → Información general → Alertas: si dice «Falta un método de pago», o el método figura pendiente de verificar, esa es la causa."
      : " Revisa también WhatsApp Manager → Información general → Alertas: si dice «Falta un método de pago», esa es la causa.";
  const ademas = verif.length ? ` Además, Meta marca ${verif.map(frase).join(" · ")}.` : "";

  // Si un token ve el método de pago y otro no, no se afirma que falte: un campo
  // que un token no alcanza a ver no es un método de pago ausente.
  if (sinMetodo && !conMetodo) {
    const moneda = sinMetodo.moneda ? ` La cuenta factura en ${sinMetodo.moneda}.` : "";
    const otros = [...pago, ...resto, ...verif];
    return {
      codigo: "pago",
      texto:
        `Meta no registra ningún método de pago en la cuenta de WhatsApp${cuenta}, y sin él no deja enviar mensajes desde el ERP. Se agrega en WhatsApp Manager → Información general → «Agregar método de pago».${moneda}` +
        (otros.length ? ` Además, Meta marca ${otros.map(frase).join(" · ")}.` : ""),
    };
  }
  if (pago.length) {
    const otros = [...resto, ...verif];
    return {
      codigo: "pago",
      texto: `Meta bloquea el envío por un tema de PAGO en ${pago.map(frase).join(" · ")}` + (otros.length ? `. Además, Meta marca ${otros.map(frase).join(" · ")}.` : ""),
    };
  }
  if (resto.length) {
    return { codigo: "bloqueo_meta", texto: `Meta bloquea el envío en ${[...resto, ...verif].map(frase).join(" · ")}.${sinPago}` };
  }

  const invalidos = lecturas.filter((l) => l.permisos?.valido === false);
  if (invalidos.length && invalidos.length === lecturas.filter((l) => l.permisos).length) {
    return {
      codigo: "token_invalido",
      texto: `Meta dice que ${invalidos.map((l) => NOMBRE_TOKEN[l.cual]).join(" y ")} ya no es válido${invalidos.length > 1 ? "s" : ""}${invalidos[0].permisos?.error ? ` (${invalidos[0].permisos.error})` : ""}.${sinPago}${ademas}`,
    };
  }

  const conPermisoLeido = lecturas.filter((l) => l.permisos?.mensajeria != null);
  if (conPermisoLeido.length && conPermisoLeido.every((l) => l.permisos!.mensajeria === false)) {
    return {
      codigo: "sin_permiso",
      texto: `Ni ${conPermisoLeido.map((l) => NOMBRE_TOKEN[l.cual]).join(" ni ")} tienen el permiso de mensajería (whatsapp_business_messaging) sobre la cuenta de WhatsApp${cuenta}: la app del ERP perdió el acceso a esa cuenta.${sinPago}${ademas}`,
    };
  }

  const fuera = lecturas.filter((l) => l.numero?.enWaba === false);
  if (fuera.length && !lecturas.some((l) => l.numero?.enWaba === true)) {
    return {
      codigo: "otra_cuenta",
      texto: `El número ya no figura en la cuenta de WhatsApp${cuenta} que tiene registrada el ERP: Meta lo pasó a otra cuenta. Hay que volver a conectarlo en /crm → «Conectar WhatsApp».${sinPago}${ademas}`,
    };
  }

  const problema = lecturas.map((l) => problemaNumero(l.numero)).find((p) => p);
  if (problema) {
    return { codigo: "numero_estado", texto: `${problema}: así no se puede enviar desde el ERP. Se revisa en WhatsApp Manager → Números de teléfono.${sinPago}${ademas}` };
  }

  if (verif.length) {
    const conPermiso = conPermisoLeido.length > 0 && conPermisoLeido.every((l) => l.permisos!.mensajeria === true);
    return {
      codigo: "verificacion",
      texto:
        `Lo único que Meta marca para los mensajes es que ${verif.map(frase).join(" · ")}.` +
        (conPermiso ? ` Los accesos del ERP siguen válidos y con permiso de mensajería sobre la cuenta${cuenta}.` : "") +
        `${sinPago} Si el negocio ya figura verificado y el rechazo sigue, hay que abrir un caso en el soporte de Meta con el fbtrace_id de este error.`,
    };
  }

  // Un LIMITED que solo explican las llamadas no limita los mensajes.
  const soloLlamadas = (l: LecturaToken) =>
    l.salud?.nivel === "LIMITED" && (l.salud?.bloqueos.length ?? 0) > 0 && l.salud!.bloqueos.every(esDeLlamadas);
  if (lecturas.some((l) => l.salud?.nivel === "AVAILABLE")) {
    return {
      codigo: "disponible",
      texto: `Meta dice que el número SÍ puede enviar (estado AVAILABLE, sin bloqueos) y aun así rechaza el envío del ERP.${sinPago} Si no es eso, hay que abrir un caso en el soporte de Meta con el fbtrace_id de este error.`,
    };
  }
  if (lecturas.some(soloLlamadas)) {
    return {
      codigo: "disponible",
      texto: `Meta solo marca límites de las LLAMADAS de WhatsApp (que el ERP no usa), nada que impida los mensajes, y aun así rechaza el envío.${sinPago} Si no es eso, hay que abrir un caso en el soporte de Meta con el fbtrace_id de este error.`,
    };
  }

  const errores = lecturas.map((l) => l.salud?.error ?? l.permisos?.error).filter(Boolean);
  return { codigo: "no_se_sabe", texto: `No se pudo consultar a Meta el estado del número${errores.length ? ` (${errores[0]})` : ""}.` };
}
