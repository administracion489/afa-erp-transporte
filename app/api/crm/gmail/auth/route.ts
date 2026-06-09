import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/crm-gmail";

// GET /api/crm/gmail/auth — inicia flujo OAuth con Google
export async function GET(_req: NextRequest) {
  try {
    const url = getAuthUrl();
    return NextResponse.redirect(url);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
