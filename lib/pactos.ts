// ──────────────────────────────────────────────────────────────────────────────
// lib/pactos.ts — Lado servidor de la conformidad del cambio.
//
// Cuando el cliente pide una unidad mayor y AFA sube el precio, el trigger de
// pacto-03 crea el acta de venta con un TOKEN. Este módulo es lo que hace que ese
// token sirva: el cliente abre un enlace sin cuenta, ve exactamente qué cambió y
// firma. Ese papel es lo que vuelve COBRABLE el diferencial — sin él, el mayor
// precio se discute al cierre y normalmente se regala.
//
// Las funciones de acá corren SOLO en el servidor (API routes) con service-role: el
// token es la única autorización y la tabla del acta nunca se expone al navegador.
// Un token da acceso a UN acta y a nada más: no lista, no navega, no ve otras.
// ──────────────────────────────────────────────────────────────────────────────

/** Lo que ve el cliente al abrir el enlace. Solo lo suyo, nada más. */
export type CambioParaCliente = {
  codigo: string;
  os: string | null;
  fecha_servicio: string | null;
  ruta: string | null;
  origen: string | null;
  destino: string | null;
  unidad_antes: string | null;
  unidad_despues: string | null;
  precio_antes: number;
  precio_despues: number;
  diferencia: number;
  motivo: string | null;
  motivo_nota: string | null;
  estado: "pendiente" | "conforme" | "observada" | "no_aplica";
  respondido_por: string | null;
  respondido_cargo: string | null;
  respondido_at: string | null;
  comentario: string | null;
  cliente: string | null;
  empresa: string;
};

const ahora = () => new Date().toISOString();

/**
 * Carga el acta de un token. Devuelve null si el token no existe: nunca se distingue
 * "no existe" de "no es tuyo", para no convertir el endpoint en un oráculo.
 */
export async function cargarCambioPorToken(sb: any, token: string): Promise<CambioParaCliente | null> {
  const { data: p } = await sb
    .from("servicio_pacto")
    .select("id,codigo,reserva_id,lado,monto_antes,monto_despues,unidad_antes,unidad_despues," +
            "motivo_clave,motivo_nota,conformidad_estado,conformidad_por,conformidad_cargo," +
            "conformidad_at,conformidad_comentario")
    .eq("token", token)
    .eq("lado", "venta")
    .maybeSingle();
  if (!p) return null;

  const { data: r } = await sb
    .from("reservas")
    .select("codigo,fecha_servicio,ruta_nombre,origen,destino,cliente_id")
    .eq("id", p.reserva_id)
    .maybeSingle();

  let cliente: string | null = null;
  if (r?.cliente_id) {
    const { data: c } = await sb.from("clientes").select("nombre,empresa").eq("id", r.cliente_id).maybeSingle();
    cliente = c?.empresa || c?.nombre || null;
  }

  let motivo: string | null = null;
  if (p.motivo_clave) {
    const { data: m } = await sb.from("pacto_motivo").select("nombre").eq("clave", p.motivo_clave).maybeSingle();
    motivo = m?.nombre ?? null;
  }

  const antes = Number(p.monto_antes ?? 0);
  const despues = Number(p.monto_despues ?? 0);

  return {
    codigo: String(p.codigo ?? `#${p.id}`),
    os: r?.codigo ?? null,
    fecha_servicio: r?.fecha_servicio ?? null,
    ruta: r?.ruta_nombre ?? null,
    origen: r?.origen ?? null,
    destino: r?.destino ?? null,
    unidad_antes: p.unidad_antes ?? null,
    unidad_despues: p.unidad_despues ?? null,
    precio_antes: antes,
    precio_despues: despues,
    diferencia: Math.round((despues - antes) * 100) / 100,
    motivo,
    motivo_nota: p.motivo_nota ?? null,
    estado: (p.conformidad_estado ?? "no_aplica") as CambioParaCliente["estado"],
    respondido_por: p.conformidad_por ?? null,
    respondido_cargo: p.conformidad_cargo ?? null,
    respondido_at: p.conformidad_at ?? null,
    comentario: p.conformidad_comentario ?? null,
    cliente,
    empresa: process.env.EMPRESA_NOMBRE || "AFA Transportes",
  };
}

/**
 * Registra la respuesta del cliente. Es la ÚNICA escritura sobre el acta que no viene
 * de un trigger, y por eso valida en el servidor —no en la pantalla— que el acta siga
 * pendiente: un enlace reenviado por correo se abre muchas veces y no puede
 * sobrescribir una respuesta ya dada.
 */
export async function registrarConformidadCambio(
  sb: any,
  token: string,
  datos: { decision: "conforme" | "observada"; por: string; cargo?: string | null; comentario?: string | null; ip?: string | null }
): Promise<{ ok: boolean; codigo?: string; error?: string }> {
  const { data: p } = await sb
    .from("servicio_pacto")
    .select("id,codigo,conformidad_estado")
    .eq("token", token).eq("lado", "venta").maybeSingle();

  if (!p) return { ok: false, error: "Este enlace no corresponde a ningún cambio de servicio." };
  if (p.conformidad_estado !== "pendiente")
    return { ok: false, error: "Este cambio ya fue respondido. Si necesitas corregir la respuesta, comunícate con nosotros." };
  if (datos.decision === "observada" && !datos.comentario?.trim())
    return { ok: false, error: "Para observar el cambio hay que indicar el motivo." };
  if (!datos.por.trim())
    return { ok: false, error: "Escribe tu nombre para dejar constancia de quién responde." };

  const { error } = await sb.from("servicio_pacto").update({
    conformidad_estado: datos.decision,
    conformidad_por: datos.por.trim(),
    conformidad_cargo: datos.cargo?.trim() || null,
    conformidad_at: ahora(),
    conformidad_ip: datos.ip ?? null,
    conformidad_comentario: datos.comentario?.trim() || null,
  }).eq("id", p.id).eq("conformidad_estado", "pendiente");
  // El filtro por estado va también en el UPDATE, no solo en la lectura de arriba:
  // dos pestañas abiertas a la vez llegarían las dos con "pendiente" en la mano.

  if (error) return { ok: false, error: error.message };
  return { ok: true, codigo: String(p.codigo ?? p.id) };
}
