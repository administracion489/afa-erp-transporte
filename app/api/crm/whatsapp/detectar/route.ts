// Detecta los números de WhatsApp de la empresa preguntándoselos a Meta y los siembra
// en `whatsapp_numeros`. Evita copiar a mano los phone_number_id, que es donde se cuela
// un error de un dígito y luego los mensajes salen por el número equivocado.
//
// De dónde salen las cuentas (WABA) a consultar, en este orden:
//   1. las que ya estén en la tabla,
//   2. las históricas de lib/whatsapp-numeros.ts (las dos de AFA),
//   3. si hay META_BUSINESS_ID, las que cuelguen de ese negocio — así aparecen también
//      las cuentas nuevas sin tocar código.
//
// USOS: sólo se deducen al INSERTAR una fila nueva, comparando el phone_number_id con
// las variables de entorno. Así la migración deja exactamente el mismo comportamiento
// que hay hoy. Nunca se tocan los usos de una fila existente: si alguien los ajustó a
// mano, detectar de nuevo no debe deshacerlo.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { WABA_FALLBACK, envPhone, invalidarCacheNumeros, type Uso } from "@/lib/whatsapp-numeros";

const GRAPH = "https://graph.facebook.com/v25.0";

type NumeroMeta = { id: string; display_phone_number?: string; verified_name?: string };

async function pedirJson(url: string, token: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, data: d };
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "configuracion");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const token = process.env.META_WA_TOKEN;
  if (!token) return NextResponse.json({ error: "META_WA_TOKEN no configurado" }, { status: 400 });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: existentes, error: errLeer } = await db.from("whatsapp_numeros").select("*");
  if (errLeer) {
    return NextResponse.json(
      { error: `No se pudo leer whatsapp_numeros: ${errLeer.message}. ¿Corriste supabase/whatsapp-numeros.sql?` },
      { status: 500 },
    );
  }

  // ── Qué cuentas consultar ──────────────────────────────────────────────────
  const wabas = new Set<string>();
  for (const f of existentes ?? []) if (f.waba_id) wabas.add(String(f.waba_id));
  for (const w of Object.values(WABA_FALLBACK)) if (w) wabas.add(w);

  const avisos: string[] = [];
  const negocio = process.env.META_BUSINESS_ID;
  if (negocio) {
    const r = await pedirJson(`${GRAPH}/${negocio}/owned_whatsapp_business_accounts?limit=50`, token);
    if (r.ok) for (const w of r.data?.data ?? []) if (w.id) wabas.add(String(w.id));
    else avisos.push(`No se pudieron listar las cuentas del negocio: ${r.data?.error?.message ?? "error"}`);
  }

  // ── Números de cada cuenta ─────────────────────────────────────────────────
  const encontrados: (NumeroMeta & { waba_id: string })[] = [];
  for (const waba of wabas) {
    const r = await pedirJson(
      `${GRAPH}/${waba}/phone_numbers?fields=id,display_phone_number,verified_name&limit=50`,
      token,
    );
    if (!r.ok) {
      // Un token sin permiso sobre una cuenta no debe abortar el resto.
      avisos.push(`WABA ${waba}: ${r.data?.error?.message ?? "no se pudo consultar"}`);
      continue;
    }
    for (const n of (r.data?.data ?? []) as NumeroMeta[]) {
      if (n.id) encontrados.push({ ...n, waba_id: waba });
    }
  }

  if (encontrados.length === 0) {
    return NextResponse.json(
      { error: "Meta no devolvió ningún número. Revisa que META_WA_TOKEN tenga permiso sobre las cuentas.", avisos },
      { status: 400 },
    );
  }

  // ── Usos libres: los índices únicos parciales sólo admiten un número por uso ──
  const yaTomado: Record<Uso, boolean> = {
    crm: (existentes ?? []).some((f) => f.usa_crm && f.activo),
    avisos: (existentes ?? []).some((f) => f.usa_avisos && f.activo),
    campanas: (existentes ?? []).some((f) => f.usa_campanas && f.activo),
  };

  const creados: string[] = [];
  const actualizados: string[] = [];

  for (const n of encontrados) {
    const display = n.display_phone_number ? n.display_phone_number.replace(/\D/g, "") : null;
    const previo = (existentes ?? []).find(
      (f) => f.phone_number_id === n.id || (display && f.display_phone_number === display),
    );

    const base = {
      phone_number_id: String(n.id),
      display_phone_number: display,
      waba_id: n.waba_id,
      alias: (n.verified_name || previo?.alias || display || "Número").toString().slice(0, 60),
      updated_at: new Date().toISOString(),
    };

    if (previo) {
      // Sin tocar usos ni `activo`: son decisiones de quien administra, no de Meta.
      const { error } = await db.from("whatsapp_numeros").update(base).eq("id", previo.id);
      if (error) avisos.push(`No se pudo actualizar ${display ?? n.id}: ${error.message}`);
      else actualizados.push(base.alias);
      continue;
    }

    // Fila nueva: se deducen los usos del entorno para no cambiar por dónde sale nada.
    const esCrm = envPhone("crm") === String(n.id);
    const esAvisos = envPhone("avisos") === String(n.id);
    const usos = {
      usa_crm: esCrm && !yaTomado.crm,
      // Hoy las campañas salen por el mismo número que el CRM (lib/campanas.ts).
      usa_campanas: esCrm && !yaTomado.campanas,
      usa_avisos: esAvisos && !yaTomado.avisos,
    };
    if (usos.usa_crm) yaTomado.crm = true;
    if (usos.usa_campanas) yaTomado.campanas = true;
    if (usos.usa_avisos) yaTomado.avisos = true;

    const { error } = await db.from("whatsapp_numeros").insert({ ...base, ...usos, activo: true });
    if (error) avisos.push(`No se pudo crear ${display ?? n.id}: ${error.message}`);
    else {
      const etiquetas = Object.entries(usos).filter(([, v]) => v).map(([k]) => k.replace("usa_", ""));
      creados.push(etiquetas.length ? `${base.alias} (${etiquetas.join(", ")})` : `${base.alias} (sin uso asignado)`);
    }
  }

  invalidarCacheNumeros();

  const { data: final } = await db
    .from("whatsapp_numeros")
    .select("*")
    .order("alias");

  return NextResponse.json({ ok: true, creados, actualizados, avisos, numeros: final ?? [] });
}
