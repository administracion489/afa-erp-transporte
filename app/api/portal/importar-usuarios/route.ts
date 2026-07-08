// POST /api/portal/importar-usuarios
// Carga masiva de usuarios del portal cliente (portal_usuarios) desde Excel.
// - Solo un administrador del ERP puede ejecutarla (bearer verificado).
// - Service role: hace upsert saltando RLS, igual que /api/pasajeros/upsert-nomina.
// - Coincidencia por (cliente_id, documento): existe → actualiza · no existe → crea.
// - Si una fila no trae contraseña, se autogenera y se devuelve para poder compartirla.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabasePublic = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Charset sin caracteres ambiguos (I, L, O, 0, 1) para claves fáciles de dictar.
const CLAVE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function generarClave(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CLAVE_CHARS[Math.floor(Math.random() * CLAVE_CHARS.length)];
  return s;
}

type UsuarioEntrada = {
  nombre: string;
  dni: string;
  tipo_doc?: "DNI" | "CE" | "Celular";
  email?: string | null;
  cargo?: string | null;
  rol?: "admin" | "visor";
  password?: string | null;
  modulos_permitidos?: string[] | null;
};

export async function POST(req: NextRequest) {
  try {
    // ── Gate de administrador ──
    const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
    if (!token) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

    const { data: authData } = await supabasePublic.auth.getUser(token);
    if (!authData.user) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });

    const { data: perfil } = await supabaseAdmin
      .from("usuarios")
      .select("rol, activo")
      .eq("id", authData.user.id)
      .single();

    if (!perfil || perfil.rol !== "admin" || perfil.activo === false) {
      return NextResponse.json({ error: "Solo un administrador puede importar usuarios" }, { status: 403 });
    }

    const { clienteId, usuarios } = (await req.json()) as { clienteId: number; usuarios: UsuarioEntrada[] };
    if (!clienteId || !Array.isArray(usuarios) || usuarios.length === 0) {
      return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
    }

    // Usuarios existentes de este cliente → map por documento
    const { data: existing, error: selErr } = await supabaseAdmin
      .from("portal_usuarios")
      .select("id, dni")
      .eq("cliente_id", clienteId);
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

    const existingMap = new Map<string, number>(
      (existing || []).map((u: { id: number; dni: string }) => [String(u.dni), u.id]),
    );

    let insertados = 0, actualizados = 0, errores = 0;
    const mensajesError: string[] = [];
    const credenciales: Array<{
      id: number | null;
      nombre: string;
      dni: string;
      tipo_doc: "DNI" | "CE" | "Celular";
      email: string | null;
      rol: "admin" | "visor";
      password: string;   // "(sin cambio)" cuando se actualizó sin nueva clave
      estado: "Nuevo" | "Actualizado";
    }> = [];

    for (const u of usuarios) {
      const dni = String(u.dni || "").trim();
      const nombre = String(u.nombre || "").trim();
      if (!nombre || !dni) { errores++; mensajesError.push(`Fila sin nombre o documento`); continue; }

      const rol: "admin" | "visor" = u.rol === "admin" ? "admin" : "visor";
      const email = (u.email || "").trim() || null;
      const cargo = (u.cargo || "").trim() || null;
      const modulos = u.modulos_permitidos ?? null;
      const tipo_doc = u.tipo_doc || "DNI";
      const existingId = existingMap.get(dni);

      if (existingId) {
        const updates: Record<string, unknown> = { nombre, cargo, rol, email, modulos_permitidos: modulos };
        const nuevaClave = (u.password || "").trim();
        if (nuevaClave) updates.codigo_acceso = nuevaClave;
        const { error } = await supabaseAdmin.from("portal_usuarios").update(updates).eq("id", existingId);
        if (error) { errores++; mensajesError.push(`${nombre}: ${error.message}`); continue; }
        actualizados++;
        credenciales.push({
          id: existingId, nombre, dni, tipo_doc, email, rol,
          password: nuevaClave || "(sin cambio)", estado: "Actualizado",
        });
      } else {
        const clave = (u.password || "").trim() || generarClave();
        const { data: nuevo, error } = await supabaseAdmin
          .from("portal_usuarios")
          .insert({
            cliente_id: clienteId, nombre, dni, cargo, rol, email,
            codigo_acceso: clave, activo: true, modulos_permitidos: modulos,
          })
          .select("id")
          .single();
        if (error) {
          errores++;
          mensajesError.push(
            error.message.includes("unique")
              ? `${nombre}: ya existe un usuario con el documento ${dni}`
              : `${nombre}: ${error.message}`,
          );
          continue;
        }
        insertados++;
        existingMap.set(dni, nuevo.id); // evita duplicar si el archivo repite el doc
        credenciales.push({
          id: nuevo?.id ?? null, nombre, dni, tipo_doc, email, rol,
          password: clave, estado: "Nuevo",
        });
      }
    }

    return NextResponse.json({ insertados, actualizados, errores, mensajesError, credenciales });
  } catch (err) {
    console.error("importar-usuarios error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
