// ══════════════════════════════════════════════════════════════════════════════
// app/api/reportes/copia-interna/route.ts
// La copia del reporte de ocupación que le llega al área de operaciones de AFA.
//
//   • GET  → qué va a hacer la copia interna HOY, resuelta con el MISMO motor
//            que usa el cron, más la fila cruda para poder editarla.
//   • POST → guarda el interruptor y los correos, y devuelve lo mismo que el GET
//            ya resuelto sobre lo recién escrito.
//
// ─── POR QUÉ ESTO NO SE LEE DESDE LA PANTALLA ───────────────────────────────
//
// Una de las tres fuentes de la cascada es `REPORTE_OCUPACION_CORREOS`, una
// variable de entorno que SOLO existe en el servidor. Un /reportes que leyera la
// tabla directo diría «sale al correo de la empresa» mientras el cron le manda a
// la dirección de Vercel — la pantalla describiendo al revés lo que hace el
// sistema, que es exactamente el defecto que este módulo vino a cerrar. Por eso
// `reporte_ocupacion_config` va con RLS y SIN política permisiva: hay una sola
// puerta, y la resolución la hace quien tiene las tres fuentes delante.
//
// El módulo es `reportes`, el mismo que exige el «Enviar ahora» de esa pantalla:
// quien puede disparar los correos puede decidir si le llega su copia.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import {
  resolverCopiaInterna, correosDeTexto, type FilaCopia,
} from "@/lib/ocupacion/copia-interna";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** ¿El error NOMBRA la tabla de la migración? Mismo patrón que `faltaMigracion`. */
const faltaTabla = (e: { message?: string } | null | undefined): boolean => {
  const m = String(e?.message ?? "").toLowerCase();
  return m.includes("reporte_ocupacion_config") && (m.includes("does not exist") || m.includes("not find"));
};

/**
 * Resuelve el estado de la copia con las TRES fuentes a la vista.
 *
 * `sin_tabla` no se deduce de una fila vacía: sin la migración la copia sigue
 * saliendo igual (`resolverCopiaInterna` lee la ausencia como «nadie la apagó»),
 * así que lo único que cambia es que el interruptor no se puede guardar — y eso
 * la pantalla tiene que poder DECIRLO nombrando el SQL, no aparentar que guardó.
 */
async function estado() {
  const [cfgRes, perfilRes] = await Promise.all([
    admin.from("reporte_ocupacion_config").select("*").eq("id", 1).maybeSingle(),
    admin.from("empresa_perfil").select("*").eq("id", 1).maybeSingle(),
  ]);
  const sinTabla = faltaTabla(cfgRes?.error);
  const fila = (cfgRes?.data as FilaCopia | null) ?? null;
  const empresa = empresaConDefectos(perfilRes?.data ?? null);

  return {
    ok: true,
    sin_tabla: sinTabla,
    // La fila que se edita. Sin migración se devuelven los defectos de la
    // columna, que es lo que el sistema está haciendo de verdad ahora mismo.
    fila: {
      copia_afa_activa: fila?.copia_afa_activa !== false,
      copia_afa_correos: fila?.copia_afa_correos ?? "",
    },
    copia: resolverCopiaInterna({
      fila,
      env: process.env.REPORTE_OCUPACION_CORREOS,
      emailEmpresa: empresa.email,
    }),
    // Para que la pantalla pueda nombrar los dos escalones de respaldo sin
    // adivinar cuáles son: cada uno se corrige en otro sitio.
    respaldos: {
      variable_entorno: correosDeTexto(process.env.REPORTE_OCUPACION_CORREOS),
      perfil_empresa: correosDeTexto(empresa.email),
    },
  };
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "reportes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json(await estado());
  } catch (e: any) {
    console.error("[copia-interna GET]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "reportes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));

    // El texto se guarda TAL CUAL lo escribió la persona, no la lista ya partida:
    // corregir una coma es volver a abrir lo que uno tecleó, y devolverle una
    // versión normalizada le esconde el error que quiere arreglar. Quien parte es
    // `correosDeTexto`, en el único sitio donde vive esa definición.
    const correos = typeof body?.copia_afa_correos === "string" ? body.copia_afa_correos.trim() : "";

    const { error } = await admin.from("reporte_ocupacion_config").upsert({
      id: 1,
      // Solo un `false` explícito apaga: cualquier otra cosa deja la copia como
      // estaba, que es lo que hace segura toda la cascada.
      copia_afa_activa: body?.copia_afa_activa !== false,
      copia_afa_correos: correos || null,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      if (faltaTabla(error)) {
        return NextResponse.json({
          ok: false,
          sin_tabla: true,
          error: "Falta correr supabase/reportes-03-copia-interna.sql",
        });
      }
      throw new Error(error.message);
    }

    return NextResponse.json(await estado());
  } catch (e: any) {
    console.error("[copia-interna POST]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
