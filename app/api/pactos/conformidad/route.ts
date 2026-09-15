// /api/pactos/conformidad — la puerta PÚBLICA por la que el cliente acepta un cambio.
//
//   GET  ?token=…  → devuelve el cambio (antes / después / diferencia)
//   POST           → registra la conformidad o la observación
//
// No exige sesión a propósito: el cliente recibe el enlace por correo o WhatsApp y
// responde sin crear usuario. La autorización ES el token —largo, aleatorio y único
// por acta, generado por la BD en supabase/pacto-03-triggers.sql—. Por eso todo pasa
// por service-role aquí y la tabla del acta NUNCA se expone al navegador.
//
// Un token da acceso a UN cambio: no lista nada, no navega a otros, no revela el resto
// de la operación de AFA ni de otros clientes.
//
// Mismo patrón que /api/liquidaciones/conformidad, que ya hace esto para el cierre
// del periodo.

import { createClient } from "@supabase/supabase-js";
import { cargarCambioPorToken, registrarConformidadCambio } from "@/lib/pactos";

export const dynamic = "force-dynamic";

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/** IP del solicitante: queda como evidencia de quién aceptó y desde dónde. */
function ipDe(req: Request): string | null {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  return (xff ? xff.split(",")[0].trim() : h.get("x-real-ip")) || null;
}

export async function GET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    // El token del acta son 48 caracteres hex. Un valor corto no se busca siquiera.
    if (!token || token.length < 16)
      return Response.json({ error: "Enlace inválido" }, { status: 400 });

    const cambio = await cargarCambioPorToken(admin(), token);
    if (!cambio)
      return Response.json({ error: "Este enlace no corresponde a ningún cambio de servicio." }, { status: 404 });

    return Response.json({ ok: true, cambio });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const token = String(body.token ?? "");
    const decision = body.decision === "observada" ? "observada" : "conforme";
    const por = String(body.por ?? "").trim();
    const cargo = body.cargo ? String(body.cargo).trim() : null;
    const comentario = body.comentario ? String(body.comentario).trim() : null;

    if (!token || token.length < 16)
      return Response.json({ error: "Enlace inválido" }, { status: 400 });

    const r = await registrarConformidadCambio(admin(), token, {
      decision, por, cargo, comentario, ip: ipDe(req),
    });
    if (!r.ok) return Response.json({ error: r.error }, { status: 409 });

    return Response.json({ ok: true, codigo: r.codigo, decision });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
