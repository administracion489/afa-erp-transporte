// app/api/campanas/plantillas/route.ts
// Diagnóstico de SOLO LECTURA: lista las plantillas (nombre/idioma/estado/categoría)
// que existen de verdad en cada WABA. Sirve para no adivinar por qué falla un envío
// de prueba (plantilla inexistente vs. idioma equivocado vs. pendiente de aprobación).

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";

const GRAPH = "https://graph.facebook.com/v25.0";

// IDs de WABA (no son secretos — identifican la cuenta, no autentican nada).
const WABA: Record<string, string> = {
  crm:    "428943170988671",   // Afa Transporte (clientes, +51 966707225)
  avisos: "1336334522036982",  // Afa Notificaciones (+51 905438216)
};

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const numero = req.nextUrl.searchParams.get("numero") === "crm" ? "crm" : "avisos";
  const waba = WABA[numero];
  const token = process.env.META_WA_TOKEN;
  if (!token) return NextResponse.json({ error: "META_WA_TOKEN no configurado" }, { status: 400 });

  try {
    const res = await fetch(
      `${GRAPH}/${waba}/message_templates?fields=name,status,language,category&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data.error?.message ?? "Error Meta" }, { status: 500 });
    return NextResponse.json({ waba, numero, plantillas: data.data ?? [] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
