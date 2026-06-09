import { NextRequest, NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/crm-gmail";

// GET /api/crm/gmail/sync — Vercel cron o trigger manual
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }
  }

  try {
    const saved = await syncGmailInbox();
    return NextResponse.json({ ok: true, nuevos: saved });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
