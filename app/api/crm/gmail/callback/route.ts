import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/crm-gmail";

// GET /api/crm/gmail/callback — Google redirige aquí con el code
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/crm?gmail_error=${error ?? "sin_code"}`, req.url)
    );
  }

  try {
    await exchangeCode(code);
    return NextResponse.redirect(new URL("/crm?gmail_ok=1", req.url));
  } catch (e: any) {
    return NextResponse.redirect(
      new URL(`/crm?gmail_error=${encodeURIComponent(e.message)}`, req.url)
    );
  }
}
