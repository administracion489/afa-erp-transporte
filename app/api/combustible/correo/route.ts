// app/api/combustible/correo/route.ts — La conexión del CORREO DE FACTURAS (el buzón donde
// llegan las facturas de Primax), aparte del Gmail del CRM. Ver lib/combustible/gmail-facturas.ts.
//
//   GET                                  → qué buzón se lee hoy y si funciona (sin el token).
//   POST { accion: "conectar" }          → URL de consentimiento de Google (solo lectura). Es
//                                          POST con Bearer y no un enlace por lo mismo que el
//                                          CRM: un enlace no lleva sesión y sería medio CSRF.
//   POST { accion: "desconectar" }       → borra la credencial del ERP (no revoca en Google).
//   POST { accion: "probar_filtro", filtro? } → qué correos encontraría, sin procesar ninguno.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { firmarStateGmail, getAuthUrl, origenPublico, SCOPE_SOLO_LECTURA } from "@/lib/crm-gmail";
import { conexionCorreoFacturas, desconectarCorreoFacturas, requisitosConexion } from "@/lib/combustible/gmail-facturas";
import { describirConexion } from "@/lib/combustible/correo-conexion";
import { probarFiltro } from "@/lib/combustible/facturas-correo";
import { cargarCuentas } from "@/lib/combustible/saldo-datos";

export const maxDuration = 60;

const MODULOS = ["combustible", "configuracion"];

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

async function estado(sb: any, origen: string) {
  const requisitos = requisitosConexion(origen);
  const con = await conexionCorreoFacturas(sb);
  return {
    ok: true,
    requisitos,
    conexion: { codigo: con.codigo, de: con.de ?? null, email: con.email, detalle: con.detalle, fuente: con.fuente, conectado_en: con.conectado_en },
    descripcion: describirConexion(con),
  };
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, MODULOS);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json(await estado(admin(), origenPublico(req)));
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, MODULOS);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = admin();

    if (body.accion === "conectar") {
      // Lo que falta se dice ANTES de mandar a Google: descubrirlo después del consentimiento
      // deja a la persona con una pantalla de error y sin saber qué hizo mal.
      const r = requisitosConexion(origenPublico(req));
      if (!r.google) return NextResponse.json({ ok: false, error: r.google_texto ?? "Falta configurar Google en Vercel." }, { status: 400 });
      if (!r.cifrado) return NextResponse.json({ ok: false, error: "Falta TOKEN_ENCRYPTION_KEY en Vercel: sin ella el ERP no guarda la credencial del correo." }, { status: 400 });
      const url = getAuthUrl(firmarStateGmail(auth.userId, "facturas"), { scope: SCOPE_SOLO_LECTURA, elegirCuenta: true });
      return NextResponse.json({ ok: true, url });
    }

    if (body.accion === "desconectar") {
      await desconectarCorreoFacturas(sb);
      return NextResponse.json(await estado(sb, origenPublico(req)));
    }

    if (body.accion === "probar_filtro") {
      // Los RUC de la cuenta entran a la consulta igual que en la sincronización: son los que
      // encuentran las facturas electrónicas, las mande quien las mande.
      const { cuentas } = await cargarCuentas(sb);
      const cuenta = cuentas.find((c) => c.activo) ?? cuentas[0];
      const filtro: string | null = typeof body.filtro === "string" && body.filtro.trim() ? body.filtro.trim() : cuenta?.correo_filtro ?? null;
      return NextResponse.json(await probarFiltro(sb, filtro, cuenta?.rucs ?? []));
    }

    return NextResponse.json({ ok: false, error: "Acción desconocida" }, { status: 400 });
  } catch (e: any) {
    console.error("[combustible/correo]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
