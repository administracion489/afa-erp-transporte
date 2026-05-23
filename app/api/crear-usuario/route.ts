import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabasePublic = createClient(supabaseUrl, anonKey);

const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const MODULOS = [
  "dashboard",
  "reservas",
  "cotizaciones",
  "clientes",
  "proveedores",
  "conductores",
  "vehiculos",
  "combustible",
  "mantenimiento",
  "neumaticos",
  "documentos",
  "facturacion",
  "gastos",
  "seguros",
  "reportes",
  "usuarios",
  "ajustes",
  "configuracion",
];

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const { data: authData } = await supabasePublic.auth.getUser(token);

    if (!authData.user) {
      return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
    }

    const { data: adminPerfil } = await supabaseAdmin
      .from("usuarios")
      .select("rol, activo")
      .eq("id", authData.user.id)
      .single();

    if (!adminPerfil || adminPerfil.rol !== "admin" || adminPerfil.activo === false) {
      return NextResponse.json(
        { error: "Solo un administrador puede crear usuarios" },
        { status: 403 }
      );
    }

    const body = await request.json();

    const nombre = String(body.nombre || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();
    const rol = body.rol === "admin" ? "admin" : "operador";

    if (!nombre || !email || !password) {
      return NextResponse.json(
        { error: "Nombre, correo y contraseña son obligatorios" },
        { status: 400 }
      );
    }

    const { data: nuevoUsuario, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          nombre,
          rol,
        },
      });

    if (authError || !nuevoUsuario.user) {
      return NextResponse.json(
        { error: authError?.message || "No se pudo crear usuario" },
        { status: 400 }
      );
    }

    const userId = nuevoUsuario.user.id;

    const { error: usuarioError } = await supabaseAdmin.from("usuarios").upsert({
      id: userId,
      email,
      nombre,
      rol,
      activo: true,
    });

    if (usuarioError) {
      return NextResponse.json({ error: usuarioError.message }, { status: 400 });
    }

    const permisos = MODULOS.map((modulo) => ({
      usuario_id: userId,
      modulo,
      permitido:
        rol === "admin"
          ? true
          : ["dashboard", "reservas", "cotizaciones", "clientes"].includes(modulo),
    }));

    const { error: permisosError } = await supabaseAdmin
      .from("permisos_usuario")
      .upsert(permisos, { onConflict: "usuario_id,modulo" });

    if (permisosError) {
      return NextResponse.json({ error: permisosError.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      usuario: {
        id: userId,
        email,
        nombre,
        rol,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Error interno" },
      { status: 500 }
    );
  }
}