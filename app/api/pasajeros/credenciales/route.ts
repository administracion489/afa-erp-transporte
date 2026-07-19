import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarCredencialEmailPasajero } from "@/lib/pasajero-email";

const supaAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
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
