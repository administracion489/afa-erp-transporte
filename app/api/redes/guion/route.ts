// app/api/redes/guion/route.ts
// Escribe (o reescribe) el GUION del video del día y lo guarda en la publicación.
//
// SOLO POST, Y NO TIENE CRON A PROPÓSITO. El guion cuesta una llamada con visión sobre
// las fotos del día, y la mayoría de publicaciones salen en modo «sin video»: pedirlo
// cada mañana gastaría tokens en un archivo que nadie iba a montar. Se escribe cuando el
// operador elige «que el agente arme el Reel», que es el momento en que hace falta.
//
// El guion se guarda NORMALIZADO (`lib/redes/guion.ts`), así que lo que queda en la base
// es lo mismo que va a pintar el montador. Guardar el crudo del modelo obligaría a
// normalizar otra vez al leerlo, y dos normalizaciones sobre el mismo dato es cómo una
// se queda atrás.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { leerConfig, marcaDeEmpresa, redactarGuion } from "@/lib/redes/ia";
import { AVISO_GUION } from "@/lib/redes/guion";

// Una llamada con visión sobre varias fotos y thinking adaptativo pasa de los 10 s.
export const maxDuration = 60;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** El error que deja una migración accesoria sin correr, NOMBRANDO la columna. */
function faltaColumna(msg: string, col: string): boolean {
  return new RegExp(`column .*${col}.* does not exist|'${col}' column`, "i").test(msg);
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "redes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const { publicacion_id, instruccion } = await req.json();
    if (!publicacion_id) return NextResponse.json({ error: "publicacion_id requerido" }, { status: 400 });

    const cfg = await leerConfig();
    if (!cfg) {
      return NextResponse.json(
        { error: "Falta la configuración de /redes. Corre supabase/redes-01-publicaciones.sql." },
        { status: 400 },
      );
    }

    // Se piden las columnas de la 02 y, si no están, se reintenta sin ellas: que falte un
    // SQL accesorio no puede impedir escribir un guion sobre la imagen principal. Lo que
    // sí se dice es que no se va a poder GUARDAR (abajo).
    let pub: any = null;
    let hayColumnas = true;
    {
      const r = await supabaseAdmin
        .from("redes_publicaciones")
        .select("id, estado, texto, imagen_url, imagenes")
        .eq("id", publicacion_id)
        .maybeSingle();
      if (r.error && faltaColumna(r.error.message, "imagenes")) {
        hayColumnas = false;
        const r2 = await supabaseAdmin
          .from("redes_publicaciones")
          .select("id, estado, texto, imagen_url")
          .eq("id", publicacion_id)
          .maybeSingle();
        pub = r2.data;
      } else {
        pub = r.data;
      }
    }

    if (!pub) return NextResponse.json({ error: "La publicación no existe." }, { status: 404 });
    if (pub.estado === "cerrada") {
      return NextResponse.json({ error: "Ya se publicó: el guion no se reescribe." }, { status: 400 });
    }

    // `imagen_url` primero y sin duplicar: es la que el resto del módulo trata como la
    // imagen del día (la que sale en Facebook e Instagram cuando no hay video).
    const extras: string[] = Array.isArray(pub.imagenes) ? pub.imagenes.filter(Boolean) : [];
    const imagenes = [pub.imagen_url, ...extras].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i);

    const marca = await marcaDeEmpresa();
    const r = await redactarGuion({
      texto: pub.texto ?? "",
      imagenes,
      cfg,
      marca,
      instruccion,
    });
    if (!r.ok || !r.guion) return NextResponse.json({ error: r.error }, { status: 400 });

    if (!hayColumnas) {
      // El guion está escrito y es bueno; lo que falta es dónde guardarlo. Se devuelve
      // igual —la pantalla puede montarlo en esta sesión— y se NOMBRA el SQL, en vez de
      // fingir que quedó guardado.
      return NextResponse.json({
        ok: true,
        guion: r.guion,
        avisos: (r.avisos ?? []).map((c) => AVISO_GUION[c]),
        no_guardado:
          "El guion no se pudo guardar: falta correr supabase/redes-02-guion-video.sql. " +
          "Puedes armar el video ahora, pero al recargar la pantalla habrá que pedirlo otra vez.",
      });
    }

    const { error } = await supabaseAdmin
      .from("redes_publicaciones")
      .update({
        guion: r.guion,
        guion_modelo: r.modelo ?? null,
        actualizado_en: new Date().toISOString(),
      })
      .eq("id", publicacion_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      guion: r.guion,
      // Los avisos salen con su TEXTO, no con el código: el código es para enrutar, y aquí
      // el consumidor es una persona.
      avisos: (r.avisos ?? []).map((c) => AVISO_GUION[c]),
    });
  } catch (e: any) {
    console.error("[redes/guion]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
