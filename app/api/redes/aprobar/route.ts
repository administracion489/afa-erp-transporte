// app/api/redes/aprobar/route.ts
// La FIRMA. Es el único sitio del ERP que pone una publicación en `aprobada`, y
// `aprobada` es lo único que el motor acepta como autorización para publicar.
//
// POR QUÉ ESTO ES UNA RUTA API Y NO UN `update` DESDE EL NAVEGADOR, como casi todo el
// resto del ERP: el gate del menú (`permisos_usuario` en app/layout.tsx) es de PANTALLA
// y se evade llamando a Supabase directamente con la clave anónima, que va en el bundle.
// En la mayoría de tablas eso es tolerable; aquí el permiso de módulo ES la diferencia
// entre alguien que puede escribir en la cara pública de la empresa y alguien que no.
// Por eso se re-verifica en el servidor, igual que `/api/elia/accion`.
//
// Y por eso queda escrito QUIÉN aprobó: `aprobada_por` + `aprobada_en`. Una publicación
// que salió mal sin nadie detrás es la que se repite.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "redes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const { publicacion_id, accion } = await req.json();
    if (!publicacion_id) return NextResponse.json({ error: "publicacion_id requerido" }, { status: 400 });

    const { data: pub } = await supabaseAdmin
      .from("redes_publicaciones")
      .select("id, estado")
      .eq("id", publicacion_id)
      .maybeSingle();
    if (!pub) return NextResponse.json({ error: "La publicación no existe." }, { status: 404 });

    if (accion === "descartar") {
      // Descartar NO borra: saber qué NO se publicó un día es parte de la historia del
      // canal, y además libera la fecha (el índice único ignora las descartadas) para
      // que se pueda volver a proponer.
      if (pub.estado === "cerrada") {
        return NextResponse.json({ error: "Ya se publicó: no se puede descartar." }, { status: 400 });
      }
      const { error } = await supabaseAdmin
        .from("redes_publicaciones")
        .update({ estado: "descartada", actualizado_en: new Date().toISOString() })
        .eq("id", publicacion_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, estado: "descartada" });
    }

    if (accion === "desaprobar") {
      // Volver atrás solo mientras no haya salido nada. Con algo ya publicado, esto
      // daría la sensación de haberlo retirado — y no retira nada de ninguna red.
      const { data: dests } = await supabaseAdmin
        .from("redes_destinos")
        .select("red, estado")
        .eq("publicacion_id", publicacion_id)
        .in("estado", ["publicado", "preparado"]);
      if (dests?.length) {
        return NextResponse.json(
          {
            error:
              `Ya salió en ${dests.length} red(es) (${dests.map((d: any) => d.red).join(", ")}). ` +
              `Desaprobar aquí no las retira: hay que borrarlas en cada plataforma.`,
          },
          { status: 400 },
        );
      }
      const { error } = await supabaseAdmin
        .from("redes_publicaciones")
        .update({ estado: "propuesta", aprobada_por: null, aprobada_en: null })
        .eq("id", publicacion_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, estado: "propuesta" });
    }

    // Aprobar.
    if (pub.estado === "cerrada") {
      return NextResponse.json({ error: "Esta publicación ya se despachó." }, { status: 400 });
    }
    const { error } = await supabaseAdmin
      .from("redes_publicaciones")
      .update({
        estado: "aprobada",
        aprobada_por: auth.userId,
        aprobada_en: new Date().toISOString(),
        actualizado_en: new Date().toISOString(),
      })
      .eq("id", publicacion_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, estado: "aprobada" });
  } catch (e: any) {
    console.error("[redes/aprobar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
