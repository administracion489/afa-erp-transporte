import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarCredencialEmailPasajero } from "@/lib/pasajero-email";
import { verificarUsuarioApi } from "@/lib/api-auth";

const supaAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Corre con service_role (se salta el RLS), así que la identidad se verifica aquí o no se
// verifica en ninguna parte. Sin este gate, un POST anónimo con una lista de ids disparaba
// correos de credenciales a pasajeros reales — spam y regalo de un vector de phishing con
// el remitente legítimo de AFA — además de leer su `pin_acceso`.
export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "clientes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json();
  const pasajeroIds: number[] = body.pasajeroIds ?? [];
  if (!pasajeroIds.length)
    return NextResponse.json({ error: "pasajeroIds requerido" }, { status: 400 });

  const { data: pasajeros, error } = await supaAdmin
    .from("pasajeros")
    .select("id, nombre, dni, email, pin_acceso, empresa")
    .in("id", pasajeroIds);

  if (error || !pasajeros)
    return NextResponse.json({ error: error?.message ?? "No encontrado" }, { status: 500 });

  let enviados = 0, sinEmail = 0, errores = 0;

  for (const p of pasajeros) {
    if (!p.email) { sinEmail++; continue; }
    try {
      await enviarCredencialEmailPasajero(p);
      enviados++;
    } catch {
      errores++;
    }
  }

  return NextResponse.json({ enviados, sinEmail, errores });
}
