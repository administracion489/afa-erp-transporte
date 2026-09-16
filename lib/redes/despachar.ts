// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/despachar.ts — SOLO SERVIDOR. El que lee, decide con el motor puro, llama
// a las plataformas y escribe el resultado.
//
// NO DECIDE NADA POR SU CUENTA. La pregunta «¿sale esto en esta red?» la contesta
// `planDePublicacion` (lib/redes/plan.ts), que es el MISMO motor que usa la pantalla de
// aprobación. Si este archivo tuviera su propia condición —aunque fuese una sola— la
// pantalla diría una cosa y el cron haría otra, que es el bug del semáforo de
// puntualidad: las dos mitades del tablero contradiciéndose.
//
// EL DOBLE POSTEO TIENE TRES CANDADOS, Y HACEN FALTA LOS TRES
//   1. `ya_publicadas` se relee de la base ANTES de planificar, así que el motor ya
//      devuelve `ya_publicada` para lo que salió.
//   2. El destino se marca `publicado` INMEDIATAMENTE después de la llamada, antes de
//      seguir con la red siguiente. Una función que muere a mitad deja escrito lo que
//      ya salió, no lo pierde.
//   3. El índice único `(publicacion_id, red)` en Postgres, que es el que aguanta dos
//      pestañas pulsando a la vez.
// Un post no se puede despublicar de la memoria de quien lo vio: aquí el error caro es
// publicar dos veces, no publicar una de menos.
// ──────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { hoyLima, ahoraLimaMin } from "@/lib/alertas";
import { planDePublicacion, type CuentaConectada, type Media, type PublicacionEnPlan } from "./plan";
import { CAPACIDADES, type ModoVideo, type Red } from "./tipos";
import { cuentaDe, cuentasParaPlan, esCredencialMuerta, marcarCuentaCaducada, marcarCuentaOk } from "./cuentas";
import { PUBLICADORES } from "./publicadores";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * ¿La URL del bucket es pública?
 *
 * Se DERIVA de la forma de la URL en vez de comprobarla con una petición: Supabase
 * sirve lo público bajo `/storage/v1/object/public/` y lo firmado bajo `/sign/` con un
 * `?token=`. Una signed URL caduca, y el motor tiene que poder juzgarlo sin salir a la
 * red — es lo que `Media.publica` DECLARA para que `plan.ts` siga siendo puro.
 */
function esUrlPublica(url: string | null | undefined): boolean {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (url.includes("/object/sign/") || url.includes("token=")) return false;
  return true;
}

export type FilaPublicacion = {
  id: number;
  fecha: string;
  hora_programada_min: number;
  texto: string;
  titulo: string | null;
  imagen_url: string | null;
  video_url: string | null;
  video_duracion_seg: number | null;
  modo_video: ModoVideo;
  redes: Red[];
  estado: "propuesta" | "aprobada" | "cerrada" | "descartada";
};

function aPlan(f: FilaPublicacion, yaPublicadas: Red[]): PublicacionEnPlan {
  const imagen: Media | null = f.imagen_url
    ? { tipo: "imagen", url: f.imagen_url, publica: esUrlPublica(f.imagen_url) }
    : null;
  const video: Media | null = f.video_url
    ? {
        tipo: "video",
        url: f.video_url,
        publica: esUrlPublica(f.video_url),
        duracion_seg: f.video_duracion_seg,
      }
    : null;
  return {
    texto: f.texto ?? "",
    imagen,
    video,
    modo_video: f.modo_video,
    redes: f.redes ?? [],
    // `aprobada` es lo ÚNICO que autoriza. Se deriva del estado de la fila y no de una
    // bandera aparte: dos formas de decir «está aprobada» es cómo una se queda atrás.
    aprobada: f.estado === "aprobada",
    hora_programada_min: f.hora_programada_min ?? 480,
    ya_publicadas: yaPublicadas,
  };
}

export type ResumenDespacho = {
  publicacion_id: number | null;
  fecha: string;
  publicadas: Red[];
  preparadas: Red[];
  fallidas: { red: Red; error: string }[];
  omitidas: { red: Red; motivo: string }[];
  notas: { red: Red; nota: string }[];
  /** Por qué no se hizo nada, cuando no se hizo nada. */
  sin_trabajo?: string;
};

/**
 * Despacha la publicación de una fecha. Lo llama el cron y el botón «Publicar ahora».
 *
 * `forzarHora` salta SOLO el control de horario, nunca el de aprobación: el botón
 * existe para adelantar algo que una persona ya firmó, no para publicar sin firmar.
 */
export async function despacharFecha(
  fecha: string,
  opts: { forzarHora?: boolean } = {},
): Promise<ResumenDespacho> {
  const vacio: ResumenDespacho = {
    publicacion_id: null,
    fecha,
    publicadas: [],
    preparadas: [],
    fallidas: [],
    omitidas: [],
    notas: [],
  };

  const sb = db();
  if (!sb) return { ...vacio, sin_trabajo: "Sin credenciales de Supabase en el servidor." };

  const { data: fila, error } = await sb
    .from("redes_publicaciones")
    .select("*")
    .eq("fecha", fecha)
    .neq("estado", "descartada")
    .maybeSingle();

  if (error) return { ...vacio, sin_trabajo: `No se pudo leer la publicación: ${error.message}` };
  if (!fila) return { ...vacio, sin_trabajo: `No hay publicación para el ${fecha}.` };

  const pub = fila as FilaPublicacion;

  // ── Candado 1: qué salió ya ──
  const { data: dests } = await sb
    .from("redes_destinos")
    .select("red, estado")
    .eq("publicacion_id", pub.id);
  const yaPublicadas = (dests ?? [])
    .filter((d: any) => d.estado === "publicado" || d.estado === "preparado")
    .map((d: any) => d.red as Red);

  const cuentas: CuentaConectada[] = await cuentasParaPlan(fecha);

  const plan = planDePublicacion({
    publicacion: aPlan(pub, yaPublicadas),
    cuentas,
    // Forzar la hora es mover el reloj al final del día, no saltarse el control: el
    // motor sigue siendo el único que decide, y sigue exigiendo la aprobación.
    ahora_min: opts.forzarHora ? 24 * 60 : ahoraLimaMin(),
  });

  const res: ResumenDespacho = { ...vacio, publicacion_id: pub.id };

  for (const destino of plan.destinos) {
    const cap = CAPACIDADES[destino.red];

    // Lo que el motor retuvo se ESCRIBE igual, con su código. Un destino sin fila es un
    // destino que la pantalla no puede explicar, y «¿por qué no salió en Instagram?»
    // acabaría contestándose con una consulta SQL.
    if (!destino.publica && destino.motivo !== "publicacion_manual") {
      if (destino.motivo !== "ya_publicada") {
        await guardarDestino(sb, pub.id, destino.red, {
          estado: "omitido",
          motivo: destino.motivo,
          detalle: destino.detalle ?? null,
        });
        res.omitidas.push({ red: destino.red, motivo: destino.motivo });
      }
      continue;
    }

    const cuenta = await cuentaDe(destino.red);
    if (!cuenta) {
      await guardarDestino(sb, pub.id, destino.red, {
        estado: "omitido",
        motivo: "sin_cuenta",
        detalle: "La cuenta desapareció entre la planificación y el envío.",
      });
      res.omitidas.push({ red: destino.red, motivo: "sin_cuenta" });
      continue;
    }

    const media =
      destino.lleva === "imagen" && pub.imagen_url
        ? ({ tipo: "imagen", url: pub.imagen_url } as const)
        : destino.lleva === "video" && pub.video_url
          ? ({ tipo: "video", url: pub.video_url } as const)
          : null;

    const t0 = Date.now();
    const r = await PUBLICADORES[destino.red](cuenta, {
      // Cada red recibe el texto RECORTADO a su tope. El motor ya rechazó lo que se
      // pasaba —así que aquí no debería recortar nada—, pero un texto editado entre la
      // planificación y el envío no puede tumbar la publicación por un carácter.
      texto: pub.texto.slice(0, cap.maxTexto),
      titulo: pub.titulo,
      media,
    });
    const ms = Date.now() - t0;

    await sb.from("redes_intentos").insert({
      publicacion_id: pub.id,
      red: destino.red,
      ok: r.ok,
      motivo: r.ok ? "listo" : "error_plataforma",
      detalle: (r.error ?? r.nota ?? "").slice(0, 1000) || null,
      id_externo: r.id_externo ?? null,
      ms,
    });

    if (r.ok) {
      // `preparado` ≠ `publicado`. El estado de WhatsApp llegó al celular; publicarlo es
      // de una persona, y marcarlo como publicado convertiría esta pantalla en un
      // informe que afirma cosas que no pasaron.
      const estado = cap.publicaPorApi ? "publicado" : "preparado";
      await guardarDestino(sb, pub.id, destino.red, {
        estado,
        motivo: cap.publicaPorApi ? "listo" : "publicacion_manual",
        detalle: r.nota ?? null,
        id_externo: r.id_externo ?? null,
        url_publicacion: r.url ?? null,
        publicado_en: new Date().toISOString(),
      });
      await marcarCuentaOk(destino.red);
      if (estado === "publicado") res.publicadas.push(destino.red);
      else res.preparadas.push(destino.red);
      if (r.nota) res.notas.push({ red: destino.red, nota: r.nota });
    } else {
      const err = r.error ?? "Error desconocido";
      await guardarDestino(sb, pub.id, destino.red, {
        estado: "fallido",
        motivo: "error_plataforma",
        detalle: null,
        error: err.slice(0, 1000),
      });
      // Una credencial muerta se marca para que MAÑANA el motor diga `cuenta_caducada`
      // —un ámbar accionable— en vez de repetir el mismo fallo genérico cada día sin
      // que nada indique que hay que reconectar. Solo ante un 401/190: bajar la bandera
      // por un 500 pasajero apagaría una red buena.
      if (esCredencialMuerta(err)) await marcarCuentaCaducada(destino.red, err);
      res.fallidas.push({ red: destino.red, error: err });
    }
  }

  // La publicación se cierra cuando ninguna red queda por intentar. Un fallo NO la
  // cierra: el próximo tick la reintenta, que es lo que salva un 500 pasajero de Meta.
  const quedaAlgo = res.fallidas.length > 0;
  if (!quedaAlgo && pub.estado === "aprobada") {
    await sb
      .from("redes_publicaciones")
      .update({ estado: "cerrada", actualizado_en: new Date().toISOString() })
      .eq("id", pub.id);
  }

  return res;
}

async function guardarDestino(
  sb: any,
  publicacion_id: number,
  red: Red,
  patch: Record<string, unknown>,
): Promise<void> {
  // `upsert` sobre el índice único `(publicacion_id, red)`: el mismo destino se
  // reevalúa en cada tick (hoy «sin aprobar», mañana «publicado») y cada tick tiene que
  // pisar el veredicto anterior, no acumular filas.
  const { error } = await sb
    .from("redes_destinos")
    .upsert(
      { publicacion_id, red, ...patch, actualizado_en: new Date().toISOString() },
      { onConflict: "publicacion_id,red" },
    );
  if (error) {
    // Best-effort: que no se pueda escribir el veredicto no puede impedir que se
    // intenten las redes que faltan. Queda en `redes_intentos`, que es append-only.
    console.error("[redes] no se pudo guardar el destino", red, error.message);
  }
}

/** Lo que llama el cron: despacha el día de hoy en Lima. */
export async function despacharHoy(): Promise<ResumenDespacho> {
  return despacharFecha(hoyLima());
}
