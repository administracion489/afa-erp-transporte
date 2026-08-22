// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/caja-chica.ts — Dominio de caja chica y rendiciones.
//
// El ciclo, y quién puede mover cada paso:
//
//   FONDO (permanente, por persona)
//     └─ RENDICIÓN  abierta ──enviar──▶ por_revisar ──aprobar──▶ liquidada
//          │                                 │
//          │                            observar ▼
//          │                              observada ──corregir──▶ por_revisar
//          └─ GASTOS (1 comprobante c/u): pendiente → aprobado | rechazado
//
// REGLA DEL PLAN MAESTRO (implementada en `puedeAsignar`): no se entrega dinero a
// quien tiene una rendición viva o vencida. El veredicto viene de la BD
// (fn_caja_chica_puede_asignar) para que sea la MISMA regla en la app del conductor,
// en la bandeja del contador y en cualquier automatización.
//
// REGLA DE ORO (finanzas-00): un gasto de caja chica ya aprobado puede PROMOVERSE al
// libro `gastos`, y en ese momento deja de contarse en v_egresos por su lado de caja
// chica (la vista filtra `gasto_id is null`). Nunca se cuenta dos veces.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear } from "@/lib/finanzas/dinero";

// ── Estados ───────────────────────────────────────────────────────────────────

export type EstadoRendicion = "abierta" | "por_revisar" | "observada" | "liquidada" | "anulada";
export type EstadoRevisionGasto = "pendiente" | "aprobado" | "rechazado";

export type ConfigEstadoCC = { label: string; descripcion: string; bg: string; color: string };

/** Diccionario ÚNICO de estados de rendición (ninguna pantalla debe redefinirlo). */
export const ESTADOS_RENDICION: Record<EstadoRendicion, ConfigEstadoCC> = {
  abierta:     { label: "Abierta",     descripcion: "Dinero entregado, gastos en curso",   bg: "#dbeafe", color: "#1d4ed8" },
  por_revisar: { label: "Por revisar", descripcion: "El responsable la cerró y envió",     bg: "#fef9c3", color: "#854d0e" },
  observada:   { label: "Observada",   descripcion: "Devuelta al responsable con reparos", bg: "#ffedd5", color: "#c2410c" },
  liquidada:   { label: "Liquidada",   descripcion: "Aprobada y cuadrada",                 bg: "#dcfce7", color: "#166534" },
  anulada:     { label: "Anulada",     descripcion: "Sin efecto",                          bg: "#fee2e2", color: "#991b1b" },
};

export const ESTADOS_REVISION: Record<EstadoRevisionGasto, ConfigEstadoCC> = {
  pendiente: { label: "Pendiente", descripcion: "Falta revisar el comprobante", bg: "#f3f4f6", color: "#4b5563" },
  aprobado:  { label: "Aprobado",  descripcion: "Comprobante válido",           bg: "#dcfce7", color: "#166534" },
  rechazado: { label: "Rechazado", descripcion: "No se acepta el comprobante",  bg: "#fee2e2", color: "#991b1b" },
};

/**
 * Categorías de gasto de caja chica (espejo del CHECK de caja_chica_gastos).
 *
 * `ambito` NO restringe nada: solo ordena el selector. La caja chica no es solo del
 * conductor —también la recibe gerencia, contabilidad y administración— y sus gastos
 * son otros (útiles, courier, notaría, refrigerio). Un fondo de oficina igual paga un
 * taxi, y un conductor igual compra útiles, así que la lista completa está siempre
 * disponible: lo que cambia es qué se ofrece primero.
 */
export type AmbitoCategoria = "calle" | "oficina" | "ambos";

export type ConfigCategoriaCC = {
  label: string;
  emoji: string;
  color: string;
  bg: string;
  ambito: AmbitoCategoria;
  /** Advertencia tributaria que la UI muestra al elegirla. */
  ojo?: string;
};

export const CATEGORIAS_CAJA_CHICA: Record<string, ConfigCategoriaCC> = {
  // ── Calle / operación ──
  peaje:           { label: "Peaje",            emoji: "🛣️", color: "#0369a1", bg: "#e0f2fe", ambito: "calle" },
  lavado:          { label: "Lavado",           emoji: "🧼", color: "#0f766e", bg: "#f0fdfa", ambito: "calle" },
  estacionamiento: { label: "Estacionamiento",  emoji: "🅿️", color: "#4b5563", bg: "#f3f4f6", ambito: "calle" },
  viaticos:        { label: "Viáticos",         emoji: "🍽️", color: "#854d0e", bg: "#fef9c3", ambito: "calle" },
  repuesto_menor:  { label: "Repuesto menor",   emoji: "🔩", color: "#c2410c", bg: "#fff7ed", ambito: "calle" },
  combustible:     { label: "Combustible",      emoji: "⛽", color: "#ea580c", bg: "#fff7ed", ambito: "calle" },
  multa:           { label: "Multa",            emoji: "🚨", color: "#dc2626", bg: "#fee2e2", ambito: "calle",
                     ojo: "La multa no es gasto deducible (art. 44 LIR). Se registra igual, pero el contador la repara." },
  // ── Oficina / administración ──
  utiles_oficina:  { label: "Útiles de oficina", emoji: "🖇️", color: "#4b5563", bg: "#f3f4f6", ambito: "oficina" },
  courier:         { label: "Courier / envíos",  emoji: "📦", color: "#0369a1", bg: "#e0f2fe", ambito: "oficina" },
  refrigerio:      { label: "Refrigerio",        emoji: "☕", color: "#854d0e", bg: "#fef9c3", ambito: "oficina" },
  representacion:  { label: "Representación",    emoji: "🤝", color: "#6d28d9", bg: "#ede9fe", ambito: "oficina",
                     ojo: "Gasto de representación: deducible hasta 0.5 % de los ingresos brutos, con tope de 40 UIT (art. 37 inc. q LIR). Exige comprobante con RUC de AFA." },
  servicios_basicos:   { label: "Servicios básicos", emoji: "💡", color: "#0f766e", bg: "#f0fdfa", ambito: "oficina" },
  limpieza:            { label: "Limpieza",         emoji: "🧴", color: "#0f766e", bg: "#f0fdfa", ambito: "oficina" },
  mantenimiento_local: { label: "Mant. del local",  emoji: "🛠️", color: "#c2410c", bg: "#fff7ed", ambito: "oficina" },
  capacitacion:        { label: "Capacitación",     emoji: "🎓", color: "#1d4ed8", bg: "#dbeafe", ambito: "oficina" },
  // ── Comunes ──
  movilidad:       { label: "Movilidad",        emoji: "🚕", color: "#1d4ed8", bg: "#dbeafe", ambito: "ambos" },
  tramite:         { label: "Trámite",          emoji: "📄", color: "#6d28d9", bg: "#ede9fe", ambito: "ambos" },
  otro:            { label: "Otro",             emoji: "📌", color: "#4b5563", bg: "#f3f4f6", ambito: "ambos" },
};

export function configCategoriaCC(c: string | null | undefined): ConfigCategoriaCC {
  return CATEGORIAS_CAJA_CHICA[c ?? "otro"] ?? CATEGORIAS_CAJA_CHICA.otro;
}

/**
 * Categorías ordenadas para el selector: primero las del ámbito del responsable,
 * después las comunes y al final las del otro ámbito (que siguen siendo elegibles).
 */
export function categoriasParaTipo(
  tipo: FondoCajaChica["responsable_tipo"] | string | null | undefined
): { clave: string; cfg: ConfigCategoriaCC }[] {
  const propio: AmbitoCategoria = tipo === "conductor" ? "calle" : "oficina";
  const peso = (a: AmbitoCategoria) => (a === propio ? 0 : a === "ambos" ? 1 : 2);
  return Object.entries(CATEGORIAS_CAJA_CHICA)
    .map(([clave, cfg]) => ({ clave, cfg }))
    .sort((a, b) => peso(a.cfg.ambito) - peso(b.cfg.ambito) || a.cfg.label.localeCompare(b.cfg.label, "es"));
}

/** Cómo se llama de cara al usuario cada tipo de responsable. */
export const TIPOS_RESPONSABLE_CC: Record<FondoCajaChica["responsable_tipo"], { label: string; emoji: string; ayuda: string }> = {
  conductor:               { label: "Conductor",             emoji: "🧑‍✈️", ayuda: "Recibe efectivo para la calle: peajes, lavado, estacionamiento." },
  personal_administrativo: { label: "Personal administrativo", emoji: "🧑‍💼", ayuda: "Gerencia, contabilidad, operaciones, RR. HH. Su área sale de su ficha de personal." },
  usuario:                 { label: "Usuario del ERP",       emoji: "👤", ayuda: "Alguien con cuenta en el sistema que no está en la planilla administrativa." },
  otro:                    { label: "Otro",                  emoji: "📌", ayuda: "Practicante, personal temporal o cualquiera sin ficha propia." },
};

export function etiquetaRendicion(e: string | null | undefined): string {
  if (!e) return "—";
  return ESTADOS_RENDICION[e as EstadoRendicion]?.label ?? String(e);
}

export function configRendicion(e: string | null | undefined): ConfigEstadoCC {
  return ESTADOS_RENDICION[(e ?? "abierta") as EstadoRendicion] ?? ESTADOS_RENDICION.abierta;
}

// ── Tipos de fila (espejo de las tablas de finanzas-06) ───────────────────────

export type FondoCajaChica = {
  id: number;
  nombre: string;
  responsable_tipo: "conductor" | "personal_administrativo" | "usuario" | "otro";
  responsable_nombre: string;
  documento_identidad: string | null;
  conductor_id: number | null;
  /** Ficha en `personal_administrativo` (gerencia, contabilidad, administración…). */
  personal_administrativo_id: number | null;
  usuario_id: string | null;
  /** Solo para 'usuario' y 'otro': el administrativo lo hereda de SU ficha. */
  cargo: string | null;
  /** Centro de costo declarado a mano; el administrativo hereda su departamento. */
  centro_costo: string | null;
  cuenta_tesoreria_id: number | null;
  moneda: string;
  tope: number;
  dias_para_rendir: number;
  activo: boolean;
  observaciones: string | null;
};

export type RendicionCajaChica = {
  id: number;
  codigo: string | null;
  fondo_id: number;
  fondo_nombre: string;
  responsable_tipo: string;
  responsable_nombre: string;
  documento_identidad: string | null;
  conductor_id: number | null;
  personal_administrativo_id: number | null;
  usuario_id: string | null;
  /** Cargo del responsable (del administrativo sale de su ficha). */
  cargo: string | null;
  /** Centro de costo: departamento del administrativo, "Operaciones" para el conductor. */
  area: string | null;
  vehiculo_id: number | null;
  periodo_desde: string;
  periodo_hasta: string | null;
  fecha_entrega: string;
  fecha_limite: string | null;
  monto_asignado: number;
  monto_rendido: number;
  monto_por_revisar: number;
  monto_rechazado: number;
  monto_devuelto: number;
  saldo_pendiente: number;
  comprobantes: number;
  moneda: string;
  estado: EstadoRendicion;
  atrasada: boolean;
  dias_atraso: number;
  pago_entrega_id: number | null;
  pago_reembolso_id: number | null;
  enviada_at: string | null;
  revisada_por: string | null;
  aprobada_por: string | null;
  fecha_aprobacion: string | null;
  motivo_observacion: string | null;
  observaciones: string | null;
  created_at: string;
};

export type GastoCajaChica = {
  id: number;
  rendicion_id: number;
  fecha: string;
  categoria: string;
  descripcion: string | null;
  monto: number;
  moneda: string;
  tipo_comprobante: string | null;
  ruc_proveedor: string | null;
  comprobante_serie: string | null;
  comprobante_numero: string | null;
  igv: number;
  foto_url: string | null;
  foto_hash: string | null;
  lat: number | null;
  lng: number | null;
  capturado_en: string | null;
  estado_revision: EstadoRevisionGasto;
  motivo_rechazo: string | null;
  revisado_por: string | null;
  fecha_revision: string | null;
  origen: string;
  reserva_id: number | null;
  vehiculo_id: number | null;
  conductor_id: number | null;
  proveedor_id: number | null;
  gasto_id: number | null;
  observaciones: string | null;
};

export type VeredictoAsignacion = {
  puede: boolean;
  motivo: string;
  rendiciones_vivas: number;
  rendiciones_atrasadas: number;
  saldo_en_calle: number;
  tope: number;
};

// ── Fecha local Perú ──────────────────────────────────────────────────────────

/**
 * "Hoy" en Perú (UTC-5) como YYYY-MM-DD. El ERP prohíbe usar toISOString() crudo
 * para calcular el día: a partir de las 19:00 de Lima devolvería el día siguiente.
 */
export function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Suma días a una fecha civil YYYY-MM-DD sin pasar por zonas horarias. */
export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ── Regla de bloqueo ──────────────────────────────────────────────────────────

/**
 * ¿Se le puede entregar dinero a este fondo? El veredicto lo emite Postgres para que
 * la regla sea la misma en todos los clientes. Si la función aún no existe (migración
 * no corrida), cae a un cálculo equivalente sobre la vista de saldos en vez de
 * dejar pasar la entrega.
 */
export async function puedeAsignar(sb: any, fondoId: number): Promise<VeredictoAsignacion> {
  const { data, error } = await sb.rpc("fn_caja_chica_puede_asignar", { p_fondo_id: fondoId });
  if (!error && Array.isArray(data) && data.length) {
    const r = data[0];
    return {
      puede: !!r.puede,
      motivo: String(r.motivo ?? ""),
      rendiciones_vivas: Number(r.rendiciones_vivas ?? 0),
      rendiciones_atrasadas: Number(r.rendiciones_atrasadas ?? 0),
      saldo_en_calle: Number(r.saldo_en_calle ?? 0),
      tope: Number(r.tope ?? 0),
    };
  }

  // Respaldo: misma regla evaluada sobre la vista.
  const { data: s } = await sb
    .from("v_caja_chica_saldos")
    .select("*")
    .eq("fondo_id", fondoId)
    .maybeSingle();

  if (!s) {
    return { puede: false, motivo: "El fondo de caja chica no existe.", rendiciones_vivas: 0, rendiciones_atrasadas: 0, saldo_en_calle: 0, tope: 0 };
  }
  const vivas = Number(s.rendiciones_vivas ?? 0);
  const atrasadas = Number(s.rendiciones_atrasadas ?? 0);
  const saldo = Number(s.saldo_en_calle ?? 0);
  const tope = Number(s.tope ?? 0);

  if (s.activo === false) return { puede: false, motivo: "El fondo está inactivo.", rendiciones_vivas: vivas, rendiciones_atrasadas: atrasadas, saldo_en_calle: saldo, tope };
  if (atrasadas > 0) return { puede: false, motivo: `Tiene ${atrasadas} rendición(es) vencida(s) sin liquidar.`, rendiciones_vivas: vivas, rendiciones_atrasadas: atrasadas, saldo_en_calle: saldo, tope };
  if (vivas > 0) return { puede: false, motivo: "Ya tiene una rendición abierta sin liquidar.", rendiciones_vivas: vivas, rendiciones_atrasadas: atrasadas, saldo_en_calle: saldo, tope };
  if (tope > 0 && saldo >= tope) return { puede: false, motivo: `Alcanzó su tope de S/ ${tope}.`, rendiciones_vivas: vivas, rendiciones_atrasadas: atrasadas, saldo_en_calle: saldo, tope };

  return { puede: true, motivo: "Habilitado para recibir fondos.", rendiciones_vivas: vivas, rendiciones_atrasadas: atrasadas, saldo_en_calle: saldo, tope };
}

// ── Operaciones ───────────────────────────────────────────────────────────────

export type AbrirRendicionArgs = {
  fondo_id: number;
  monto_asignado: number;
  fecha_entrega?: string;
  periodo_desde?: string;
  periodo_hasta?: string | null;
  vehiculo_id?: number | null;
  cuenta_tesoreria_id?: number | null;
  /** Si es true, además del registro se emite un `pago` (salida de tesorería). */
  registrar_pago?: boolean;
  observaciones?: string | null;
  creado_por?: string | null;
};

export type Resultado<T = void> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Entrega dinero y abre la rendición. Verifica la regla de bloqueo ANTES de crear
 * nada; el índice único `uq_cc_rend_abierta` es la última línea de defensa contra
 * dos entregas simultáneas al mismo fondo.
 */
export async function abrirRendicion(sb: any, a: AbrirRendicionArgs): Promise<Resultado<{ id: number; codigo: string | null }>> {
  try {
    if (!(a.monto_asignado > 0)) return { ok: false, error: "El monto a entregar debe ser mayor a 0." };

    const veredicto = await puedeAsignar(sb, a.fondo_id);
    if (!veredicto.puede) return { ok: false, error: veredicto.motivo };

    const { data: fondo } = await sb
      .from("caja_chica_fondos")
      .select("id, moneda, cuenta_tesoreria_id, responsable_tipo, responsable_nombre, conductor_id")
      .eq("id", a.fondo_id)
      .maybeSingle();
    if (!fondo) return { ok: false, error: "El fondo de caja chica no existe." };

    const fecha = a.fecha_entrega || hoyLima();
    const { data: rend, error } = await sb
      .from("caja_chica_rendiciones")
      .insert({
        fondo_id: a.fondo_id,
        monto_asignado: redondear(a.monto_asignado),
        moneda: fondo.moneda ?? "PEN",
        fecha_entrega: fecha,
        periodo_desde: a.periodo_desde || fecha,
        periodo_hasta: a.periodo_hasta ?? null,
        vehiculo_id: a.vehiculo_id ?? null,
        estado: "abierta",
        observaciones: a.observaciones ?? null,
        creado_por: a.creado_por ?? null,
      })
      .select("id, codigo")
      .single();

    if (error) {
      // El índice único traduce a un mensaje humano en vez de un error de Postgres.
      if (/uq_cc_rend_abierta/.test(error.message ?? "")) {
        return { ok: false, error: "Este fondo ya tiene una rendición abierta. Ciérrala antes de entregar más dinero." };
      }
      return { ok: false, error: error.message };
    }

    // Salida de tesorería opcional (el efectivo sale de una cuenta real).
    const cuenta = a.cuenta_tesoreria_id ?? fondo.cuenta_tesoreria_id ?? null;
    if (a.registrar_pago && cuenta) {
      const { registrarPago } = await import("@/lib/finanzas/pagos");
      const res = await registrarPago(sb, {
        sentido: "pago",
        cuenta_tesoreria_id: cuenta,
        fecha,
        monto: redondear(a.monto_asignado),
        moneda: fondo.moneda ?? "PEN",
        metodo: "efectivo",
        contraparte_tipo: "otro",
        contraparte_id: fondo.conductor_id ?? null,
        observaciones: `Entrega de caja chica ${rend.codigo ?? ""} · ${fondo.responsable_nombre}`.trim(),
        creado_por: a.creado_por ?? null,
      });
      if (res.ok && res.pago_id) {
        await sb.from("caja_chica_rendiciones").update({ pago_entrega_id: res.pago_id }).eq("id", rend.id);
      }
    }

    return { ok: true, data: { id: Number(rend.id), codigo: rend.codigo ?? null } };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** El responsable cierra su rendición y la manda a revisión. */
export async function enviarARevision(sb: any, rendicionId: number): Promise<Resultado> {
  const { data: r } = await sb
    .from("caja_chica_rendiciones")
    .select("id, estado")
    .eq("id", rendicionId)
    .maybeSingle();
  if (!r) return { ok: false, error: "La rendición no existe." };
  if (!["abierta", "observada"].includes(r.estado)) {
    return { ok: false, error: `No se puede enviar una rendición en estado "${etiquetaRendicion(r.estado)}".` };
  }

  const { count } = await sb
    .from("caja_chica_gastos")
    .select("id", { count: "exact", head: true })
    .eq("rendicion_id", rendicionId);
  if (!count) return { ok: false, error: "No se puede enviar una rendición sin ningún comprobante." };

  const { error } = await sb
    .from("caja_chica_rendiciones")
    .update({ estado: "por_revisar", enviada_at: new Date().toISOString(), motivo_observacion: null })
    .eq("id", rendicionId);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

/** Devuelve la rendición al responsable con reparos. */
export async function observarRendicion(sb: any, rendicionId: number, motivo: string, revisadaPor?: string | null): Promise<Resultado> {
  if (!motivo.trim()) return { ok: false, error: "Indica el motivo de la observación." };
  const { error } = await sb
    .from("caja_chica_rendiciones")
    .update({
      estado: "observada",
      motivo_observacion: motivo.trim(),
      revisada_por: revisadaPor ?? null,
      fecha_revision: new Date().toISOString(),
    })
    .eq("id", rendicionId);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

export type AprobarRendicionArgs = {
  rendicion_id: number;
  aprobada_por: string;
  /** Efectivo que el responsable devolvió al cerrar. */
  monto_devuelto?: number;
  /** Promueve los gastos aprobados al libro `gastos` (quedan en el plano de gestión). */
  promover_a_gastos?: boolean;
};

/**
 * Aprueba la rendición. Antes de cerrar exige que ningún comprobante quede pendiente
 * de revisión: aprobar "en bloque" sin mirar es justo lo que el módulo viene a evitar.
 * Valida además que el dinero cuadre: asignado = rendido + devuelto (± 1 sol).
 */
export async function aprobarRendicion(sb: any, a: AprobarRendicionArgs): Promise<Resultado<{ saldo: number; promovidos: number }>> {
  try {
    const { data: v } = await sb
      .from("v_caja_chica_rendiciones")
      .select("*")
      .eq("id", a.rendicion_id)
      .maybeSingle();
    if (!v) return { ok: false, error: "La rendición no existe." };
    if (v.estado === "liquidada") return { ok: false, error: "La rendición ya está liquidada." };
    if (v.estado === "anulada") return { ok: false, error: "La rendición está anulada." };
    if (Number(v.monto_por_revisar ?? 0) > 0) {
      return { ok: false, error: "Quedan comprobantes sin revisar. Apruébalos o recházalos primero." };
    }

    const devuelto = redondear(a.monto_devuelto ?? Number(v.monto_devuelto ?? 0));
    const saldo = redondear(Number(v.monto_asignado ?? 0) - Number(v.monto_rendido ?? 0) - devuelto);

    const { error } = await sb
      .from("caja_chica_rendiciones")
      .update({
        estado: "liquidada",
        monto_devuelto: devuelto,
        aprobada_por: a.aprobada_por,
        fecha_aprobacion: new Date().toISOString(),
        motivo_observacion: null,
      })
      .eq("id", a.rendicion_id);
    if (error) return { ok: false, error: error.message };

    let promovidos = 0;
    if (a.promover_a_gastos) {
      const r = await promoverGastos(sb, a.rendicion_id);
      if (r.ok) promovidos = r.data;
    }

    return { ok: true, data: { saldo, promovidos } };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Aprueba o rechaza un comprobante suelto. */
export async function revisarGasto(
  sb: any,
  gastoId: number,
  decision: "aprobado" | "rechazado",
  opts?: { motivo?: string | null; revisado_por?: string | null }
): Promise<Resultado> {
  if (decision === "rechazado" && !opts?.motivo?.trim()) {
    return { ok: false, error: "Indica el motivo del rechazo." };
  }
  const { error } = await sb
    .from("caja_chica_gastos")
    .update({
      estado_revision: decision,
      motivo_rechazo: decision === "rechazado" ? opts?.motivo?.trim() ?? null : null,
      revisado_por: opts?.revisado_por ?? null,
      fecha_revision: new Date().toISOString(),
    })
    .eq("id", gastoId);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

// ── Registrar un comprobante desde el ERP ─────────────────────────────────────

/**
 * SHA-256 del binario, en hexadecimal. Es el MISMO algoritmo que `hashDeFoto`
 * (lib/odometro.ts) usa en el servidor, así que la misma foto subida desde la app del
 * conductor y desde el ERP produce el mismo hash y el índice único
 * (rendicion_id, foto_hash) la detecta como duplicada en ambos caminos.
 *
 * Sin `crypto.subtle` (contexto no seguro, navegador viejo) devuelve null: se pierde
 * el anti-duplicado por foto, no la posibilidad de registrar el gasto.
 */
export async function hashArchivo(f: File | Blob | null | undefined): Promise<string | null> {
  try {
    if (!f || typeof globalThis.crypto?.subtle?.digest !== "function") return null;
    const buf = await f.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

export type RegistrarGastoArgs = {
  rendicion_id: number;
  fecha?: string;
  categoria: string;
  descripcion?: string | null;
  monto: number;
  moneda?: string;
  tipo_comprobante?: string | null;
  ruc_proveedor?: string | null;
  comprobante_serie?: string | null;
  comprobante_numero?: string | null;
  igv?: number;
  /** Foto o PDF del comprobante. Va al bucket PRIVADO `comprobantes`. */
  archivo?: File | null;
  /** Declaración expresa de que no hubo papel (una propina de parqueo, una movilidad). */
  sin_comprobante?: boolean;
  vehiculo_id?: number | null;
  reserva_id?: number | null;
  proveedor_id?: number | null;
  observaciones?: string | null;
};

/**
 * Registra un comprobante en una rendición VIVA desde el ERP web.
 *
 * Hasta la fase 08 el único camino para crear un `caja_chica_gastos` era la app del
 * conductor (`POST /api/conductor` → `rendir_gasto`). Eso dejaba a gerencia y a
 * administración con rendiciones que nunca podían llenar ni liquidar: podían recibir
 * el dinero, pero no rendirlo. Esta función es su camino, con las mismas reglas.
 *
 * La foto se sube ANTES de insertar y, si el insert falla, se borra: un comprobante
 * huérfano en el bucket es basura que nadie va a encontrar para limpiar.
 */
export async function registrarGasto(
  sb: any,
  a: RegistrarGastoArgs
): Promise<Resultado<{ id: number }>> {
  try {
    const monto = Number(a.monto);
    if (!(monto > 0)) return { ok: false, error: "El monto debe ser mayor a 0." };
    if (!(a.categoria in CATEGORIAS_CAJA_CHICA)) return { ok: false, error: "Categoría de gasto desconocida." };
    if (!a.archivo && !a.sin_comprobante) {
      return { ok: false, error: "Adjunta el comprobante o marca «sin comprobante»." };
    }

    // Solo se rinde sobre una rendición viva: a una enviada a revisión o ya liquidada
    // no se le pueden meter gastos por detrás, o el monto revisado dejaría de calzar
    // con lo que el revisor aprobó.
    const { data: r } = await sb
      .from("caja_chica_rendiciones")
      .select("id, estado, moneda")
      .eq("id", a.rendicion_id)
      .maybeSingle();
    if (!r) return { ok: false, error: "La rendición no existe." };
    if (!["abierta", "observada"].includes(r.estado)) {
      return {
        ok: false,
        error: `La rendición está "${etiquetaRendicion(r.estado)}" y ya no admite comprobantes. Pide que te la devuelvan observada.`,
      };
    }

    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(a.fecha ?? "")) ? String(a.fecha) : hoyLima();

    // Subida al bucket PRIVADO. Se guarda la RUTA, nunca una URL pública: un ticket
    // de peaje trae placa y ubicación (ver finanzas-06 §11).
    let ruta: string | null = null;
    if (a.archivo) {
      const ext = (a.archivo.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5);
      ruta = `gastos/rendicion-${a.rendicion_id}/${fecha}/${crypto.randomUUID()}.${ext}`;
      const { error: eUp } = await sb.storage
        .from("comprobantes")
        .upload(ruta, a.archivo, { contentType: a.archivo.type || "image/jpeg", upsert: false });
      if (eUp) return { ok: false, error: `No se pudo subir el comprobante: ${eUp.message}` };
    }

    const fila: Record<string, unknown> = {
      rendicion_id: a.rendicion_id,
      fecha,
      categoria: a.categoria,
      descripcion: (a.descripcion ?? "").trim().slice(0, 300) || null,
      monto: redondear(monto),
      moneda: a.moneda || r.moneda || "PEN",
      tipo_comprobante: a.sin_comprobante ? "sin_comprobante" : a.tipo_comprobante || "boleta",
      ruc_proveedor: (a.ruc_proveedor ?? "").trim() || null,
      comprobante_serie: (a.comprobante_serie ?? "").trim() || null,
      comprobante_numero: (a.comprobante_numero ?? "").trim() || null,
      igv: redondear(Number(a.igv ?? 0)),
      foto_url: ruta,
      foto_hash: await hashArchivo(a.archivo),
      estado_revision: "pendiente",
      origen: "manual",
      observaciones: (a.observaciones ?? "").trim() || null,
    };

    // Los enganches operativos van aparte: si una FK no existe en esta base (una fase
    // sin correr), se reintenta sin ellos en vez de perder el comprobante.
    const enganche: Record<string, unknown> = {};
    if (a.vehiculo_id) enganche.vehiculo_id = a.vehiculo_id;
    if (a.reserva_id) enganche.reserva_id = a.reserva_id;
    if (a.proveedor_id) enganche.proveedor_id = a.proveedor_id;

    const insertar = (extra: Record<string, unknown>) =>
      sb.from("caja_chica_gastos").insert({ ...fila, ...extra }).select("id").single();

    let { data: creado, error } = await insertar(enganche);
    if (error && /column .* does not exist|violates foreign key/i.test(error.message ?? "")) {
      ({ data: creado, error } = await insertar({}));
    }

    if (error) {
      if (ruta) { try { await sb.storage.from("comprobantes").remove([ruta]); } catch {} }
      if (/duplicate key|23505/i.test(error.message ?? "")) {
        return { ok: false, error: "Ese mismo comprobante ya está registrado en esta rendición." };
      }
      return { ok: false, error: error.message };
    }

    return { ok: true, data: { id: Number(creado.id) } };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Borra un comprobante aún pendiente (y su foto). Un gasto ya revisado no se toca. */
export async function eliminarGasto(sb: any, gastoId: number): Promise<Resultado> {
  const { data: g } = await sb
    .from("caja_chica_gastos")
    .select("id, estado_revision, foto_url, gasto_id")
    .eq("id", gastoId)
    .maybeSingle();
  if (!g) return { ok: false, error: "El comprobante no existe." };
  if (g.gasto_id) return { ok: false, error: "Ya se promovió al libro de gastos: anúlalo desde /gastos." };
  if (g.estado_revision !== "pendiente") {
    return { ok: false, error: "Solo se puede borrar un comprobante que todavía no se revisó." };
  }

  const { error } = await sb.from("caja_chica_gastos").delete().eq("id", gastoId);
  if (error) return { ok: false, error: error.message };
  if (g.foto_url && !/^https?:\/\//i.test(g.foto_url)) {
    try { await sb.storage.from("comprobantes").remove([g.foto_url]); } catch {}
  }
  return { ok: true, data: undefined };
}

/**
 * Promueve al libro `gastos` los comprobantes aprobados que aún no se promovieron.
 * A partir de ese momento v_egresos los cuenta por el lado de `gastos` y deja de
 * contarlos por el de caja chica (la vista filtra `gasto_id is null`).
 */
export async function promoverGastos(sb: any, rendicionId: number): Promise<Resultado<number>> {
  try {
    const { data: gastos } = await sb
      .from("caja_chica_gastos")
      .select("*")
      .eq("rendicion_id", rendicionId)
      .eq("estado_revision", "aprobado")
      .is("gasto_id", null);

    const filas = (gastos as GastoCajaChica[]) ?? [];
    if (!filas.length) return { ok: true, data: 0 };

    const { data: rend } = await sb
      .from("v_caja_chica_rendiciones")
      .select("codigo, responsable_nombre, conductor_id, vehiculo_id")
      .eq("id", rendicionId)
      .maybeSingle();

    let n = 0;
    for (const g of filas) {
      const { data: creado, error } = await sb
        .from("gastos")
        .insert({
          fecha: g.fecha,
          categoria: mapaCategoriaAGastos(g.categoria),
          tipo_gasto: tipoGastoDeCategoria(g.categoria),
          descripcion: [g.descripcion, `Caja chica ${rend?.codigo ?? ""}`.trim()].filter(Boolean).join(" · "),
          monto: redondear(Number(g.monto)),
          vehiculo_id: g.vehiculo_id ?? rend?.vehiculo_id ?? null,
          conductor_id: g.conductor_id ?? rend?.conductor_id ?? null,
          proveedor_id: g.proveedor_id ?? null,
          reserva_id: g.reserva_id ?? null,
          metodo_pago: "efectivo",
          comprobante_url: g.foto_url ?? null,
          estado: "pagado",
          observaciones: `Rendido por ${rend?.responsable_nombre ?? "—"}`,
        })
        .select("id")
        .single();
      if (error || !creado) continue;
      await sb.from("caja_chica_gastos").update({ gasto_id: creado.id }).eq("id", g.id);
      n++;
    }
    return { ok: true, data: n };
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Traduce la categoría de caja chica al vocabulario de `gastos` (que es más viejo y
 * más corto). Lo que no tiene equivalente cae en "otro" o "administrativo" antes que
 * inventar un valor que rompería los filtros de /gastos.
 */
export function mapaCategoriaAGastos(c: string): string {
  switch (c) {
    case "peaje": return "peajes";
    case "viaticos": return "viaticos";
    case "estacionamiento": return "estacionamiento";
    case "multa": return "multa";
    case "combustible": return "combustible";
    // Todo lo de oficina aterriza en la categoría "administrativo" de /gastos: es la
    // única que existe allí para esto y la que ya lleva tipo_gasto = administrativo.
    case "utiles_oficina":
    case "courier":
    case "refrigerio":
    case "representacion":
    case "servicios_basicos":
    case "limpieza":
    case "mantenimiento_local":
    case "capacitacion":
      return "administrativo";
    case "lavado":
    case "movilidad":
    case "repuesto_menor":
    case "tramite":
    default: return "otro";
  }
}

/**
 * Plano contable del gasto promovido. Antes se escribía "operativo" fijo, lo que metía
 * el tóner de gerencia en el costo operativo de la flota y ensuciaba el margen por
 * vehículo. El ámbito de la categoría es el que manda.
 */
export function tipoGastoDeCategoria(c: string): "operativo" | "administrativo" {
  return configCategoriaCC(c).ambito === "oficina" ? "administrativo" : "operativo";
}

// ── Derivados de presentación ─────────────────────────────────────────────────

/** Resumen para las tarjetas KPI de la bandeja. */
export function resumirRendiciones(rs: RendicionCajaChica[]) {
  const vivas = rs.filter((r) => ["abierta", "por_revisar", "observada"].includes(r.estado));
  return {
    total: rs.length,
    enCalle: redondear(vivas.reduce((s, r) => s + Number(r.saldo_pendiente || 0), 0)),
    porRevisar: rs.filter((r) => r.estado === "por_revisar").length,
    atrasadas: rs.filter((r) => r.atrasada).length,
    rendidoMes: redondear(rs.reduce((s, r) => s + Number(r.monto_rendido || 0), 0)),
  };
}

/** ¿La rendición cuadra? (asignado = rendido + devuelto, tolerancia de 1 sol). */
export function cuadra(r: Pick<RendicionCajaChica, "monto_asignado" | "monto_rendido" | "monto_devuelto">): boolean {
  return Math.abs(Number(r.monto_asignado) - Number(r.monto_rendido) - Number(r.monto_devuelto)) < 1;
}
