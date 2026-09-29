import { NextRequest, NextResponse } from "next/server";
import { firmarStateGmail, getAuthUrl } from "@/lib/crm-gmail";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";

// POST /api/crm/gmail/auth — devuelve la URL de consentimiento de Google con un `state`
// firmado. Es POST con Bearer (y no un GET que redirige) porque un enlace no puede llevar la
// cabecera Authorization: la pantalla pide la URL y navega ella. Conectar la bandeja define
// desde qué cuenta lee y envía el CRM, así que solo CRM o configuración.
export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, ["crm", "configuracion"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json({ url: getAuthUrl(firmarStateGmail(auth.userId)) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// El GET abierto que redirigía a Google ya no inicia nada: sin sesión ni `state` era la mitad
// de un CSRF de login OAuth.
export async function GET() {
  return NextResponse.json(
    { error: "Inicia la conexión desde /crm con el botón «Conectar Gmail»." },
    { status: 405 },
  );
}
