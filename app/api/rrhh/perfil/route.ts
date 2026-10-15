// app/api/rrhh/perfil/route.ts — Perfil de autoservicio del empleado.
//
//   GET  → perfil propio + ficha derivada (conductor/administrativo) + saldo de vacaciones +
//          estado de consentimientos. La foto se devuelve FIRMADA (bucket privado).
//   POST → escribe SOLO la lista blanca de columnas AUTOEDITABLES, forzando usuario_id del
//          token. Nunca correo/sueldo/rol/consentimiento/marca_asistencia.
//
// La identidad es SIEMPRE la del token. El cliente nunca escribe empleado_perfil directo:
// su política RLS no tiene INSERT/UPDATE, solo este endpoint (service-role) lo hace.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh, subirArrhh, firmarRutaRrhh, AdjuntoInvalido } from "@/lib/rrhh/server";
import {
  fichaDeUsuario, saldoDeUsuario, estadoConsentimientos,
} from "@/lib/rrhh/perfil-datos";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

// Las ÚNICAS columnas que el dueño de la fila puede escribir. Todo lo demás (consentimientos,
// marca_asistencia, correo, sueldo, rol) queda fuera: su fuente es otra tabla u otro endpoint.
const AUTOEDITABLES = [
  "fecha_nacimiento", "telefono_personal", "direccion",
  "contacto_emergencia_nombre", "contacto_emergencia_telefono", "contacto_emergencia_parentesco",
] as const;

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId;

  try {
    const sb = adminRrhh();

    const [usuRes, perfilRes] = await Promise.all([
      sb.from("usuarios").select("id,nombre,rol,activo").eq("id", usuarioId).maybeSingle(),
      sb.from("empleado_perfil").select("*").eq("usuario_id", usuarioId).maybeSingle(),
    ]);

    // Sin la tabla del perfil, la pantalla se comporta como si las columnas no existieran.
    let sinMigracion = false;
    let perfil: Record<string, unknown> | null = null;
    if (perfilRes.error) {
      if (tablaFaltante(perfilRes.error, "empleado_perfil")) sinMigracion = true;
      else throw perfilRes.error;
    } else {
      perfil = perfilRes.data ?? null;
    }

    const ficha = await fichaDeUsuario(sb, usuarioId);
    if (ficha.sinMigracion) sinMigracion = true;

    const saldo = sinMigracion
      ? { saldo: null, motivo: `Falta correr ${SQL}.` }
      : await saldoDeUsuario(sb, usuarioId, ficha.ingreso);

    const fotoFirmada = await firmarRutaRrhh(sb, perfil?.foto_url);

    // La foto en claro (ruta) no se devuelve; sí la firmada. Los consentimientos se publican
    // por su helper (no se filtran versiones ni fechas crudas de más).
    const perfilPublico = perfil
      ? {
          foto_url_firmada: fotoFirmada,
          fecha_nacimiento: perfil.fecha_nacimiento ?? null,
          telefono_personal: perfil.telefono_personal ?? null,
          direccion: perfil.direccion ?? null,
          contacto_emergencia_nombre: perfil.contacto_emergencia_nombre ?? null,
          contacto_emergencia_telefono: perfil.contacto_emergencia_telefono ?? null,
          contacto_emergencia_parentesco: perfil.contacto_emergencia_parentesco ?? null,
          marca_asistencia: perfil.marca_asistencia ?? false,
          updated_at: perfil.updated_at ?? null,
        }
      : null;

    return NextResponse.json({
      ok: true,
      ...(sinMigracion ? { sin_migracion: SQL } : {}),
      usuario: usuRes.data ?? { id: usuarioId, nombre: null },
      perfil: perfilPublico,
      ficha: { clase: ficha.clase, datos: ficha.ficha, fecha_ingreso: ficha.ingreso.fecha, fuente_fecha_ingreso: ficha.ingreso.fuente },
      saldo_vacaciones: saldo,
      consentimientos: estadoConsentimientos(perfil),
    });
  } catch (e: any) {
    console.error("[rrhh/perfil GET]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}

// POST (y PATCH, mismo cuerpo) — editar los campos autoeditables del propio perfil.
async function editar(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId;

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sb = adminRrhh();

    const fila: Record<string, unknown> = { usuario_id: usuarioId, updated_at: new Date().toISOString() };
    for (const campo of AUTOEDITABLES) {
      if (campo in body) fila[campo] = body[campo] === "" ? null : body[campo];
    }

    // Foto de perfil: la sube el SERVIDOR al bucket privado, re-encodeada sin EXIF/GPS. Un archivo
    // inválido → 400; un fallo de Storage → se guarda el resto del perfil sin la foto.
    let fotoOmitida = false;
    if (body.foto) {
      try {
        fila.foto_url = await subirArrhh(sb, `perfil/${usuarioId}/${crypto.randomUUID()}`, body.foto, "foto");
      } catch (e) {
        if (e instanceof AdjuntoInvalido) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
        fotoOmitida = true;
      }
    }

    const up = await escribirDegradando("empleado_perfil", fila, (f) =>
      sb.from("empleado_perfil").upsert(f, { onConflict: "usuario_id" }).select("*"));
    if (up.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!up.ok) return NextResponse.json({ ok: false, error: up.error?.message ?? "No se pudo guardar." }, { status: 500 });

    const fotoFirmada = await firmarRutaRrhh(sb, (up.data as any)?.foto_url);
    return NextResponse.json({
      ok: true,
      guardado: true,
      foto_omitida: fotoOmitida,
      foto_url_firmada: fotoFirmada,
      columnas_omitidas: up.columnasOmitidas,
    });
  } catch (e: any) {
    console.error("[rrhh/perfil POST]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}

export const POST = editar;
export const PATCH = editar;
