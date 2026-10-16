// app/api/rrhh/marcar/route.ts — Marcación de asistencia (facial, con verificación 1:1).
//
//   POST (pantalla /mi-perfil, módulo `mi-perfil`):
//     { tipo?, lat, lng, precision_m?, rostro_detectado?, foto, descriptor? }  → registra el fichaje.
//
// LA IDENTIDAD ES LA DEL TOKEN, jamás la del body: un `usuario_id` en el cuerpo se ignora. El
// SERVIDOR recomputa la geocerca (no confía en el `dentro_geocerca` del cliente), DERIVA el
// tipo con `tipoSiguiente` (nadie marca "salida" antes de "entrada"), exige consentimiento
// biométrico vigente (sin él, 403 y método alterno), y sube la foto al bucket PRIVADO `rrhh`.
// Si falta la migración → 422. Si la foto falla → la marca se registra SIN foto (no se pierde).
//
// VERIFICACIÓN FACIAL 1:1 (rrhh-03). El cliente calcula un `descriptor` de 128 números con face-api
// y lo manda en el body; el SERVIDOR lo valida (`esDescriptorValido`) y decide, en este ORDEN exacto:
//   1. FACIAL NO DISPONIBLE = falta la tabla `rrhh_rostro_ref` (migración rrhh-03 sin correr) O no hay
//      TOKEN_ENCRYPTION_KEY (no se puede cifrar/descifrar la plantilla). → DEGRADA al comportamiento de
//      HOY: registra la marca como siempre (foto + rostro_detectado) con `rostro_verificado: null`.
//      ÚNICO fail-open: nunca se bloquea por infraestructura ausente.
//   2. FACIAL DISPONIBLE: exige consentimiento `facial` (Ley 29733; sin él 403 + PIN, NO registra) y un
//      descriptor válido (si no, 422 `no_se_detecto_rostro`, REINTENTABLE, NO registra). Luego:
//        · SIN referencia → ENROLA: esta plantilla pasa a ser la referencia (cifrada); marca verificada.
//        · CON referencia → compara 1:1 (`decidirRostro`): coincide → registra; `no_coincide` → 403,
//          NO registra (nadie marca por otro); referencia ilegible → 409, NO registra (sin comparar).
//
// REGLA DURA: con la verificación facial ACTIVA y una referencia presente, NINGÚN camino registra la
// marca sin que `decidirRostro` haya dado `coincide` (salvo la degradación honesta del punto 1). El
// `descriptor` y el `descriptor_cifrado` NUNCA viajan en la respuesta.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { validarMarca, tipoSiguiente, esTipoMarca } from "@/lib/rrhh/marcacion";
import { calcularJornada } from "@/lib/rrhh/jornada";
import { cargarConfigRrhh, marcasDeHoy, hoyLimaFecha } from "@/lib/rrhh/marcacion-datos";
import { consentimientoVigente } from "@/lib/rrhh/consentimiento";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh, subirArrhh, AdjuntoInvalido } from "@/lib/rrhh/server";
import { tablaFaltante } from "@/lib/columna-faltante";
import { cifrar, descifrar, cifradoDisponible } from "@/lib/meta-tokens";
import { decidirRostro, esDescriptorValido, serializarDescriptor, deserializarDescriptor } from "@/lib/rrhh/rostro";

export const maxDuration = 60;

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

/** Tope del cuerpo. La foto (base64) ya se tope a 5 MB decodificada (~6.7 MB en base64); 12 MB deja
 *  holgura para la foto + el descriptor (128 números) + los demás campos, y frena un cuerpo absurdo
 *  antes de parsearlo. El descriptor lo tope `esDescriptorValido` (exige EXACTAMENTE 128 valores). */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId; // IDENTIDAD = token, nunca el body

  try {
    // 0) Cuerpo con tope de tamaño. Content-Length primero (barato); el largo real, de respaldo
    //    (la cabecera puede faltar o mentir). Un cuerpo enorme se rechaza antes de parsearlo.
    const declarado = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declarado) && declarado > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "El cuerpo de la solicitud es demasiado grande." }, { status: 413 });
    }
    const raw = await req.text().catch(() => "");
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "El cuerpo de la solicitud es demasiado grande." }, { status: 413 });
    }
    let body: Record<string, unknown> = {};
    if (raw) { try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = {}; } }

    const sb = adminRrhh();

    // 1) Config de sede/horario. Sin migración → 422.
    const { cfg, sinMigracion } = await cargarConfigRrhh(sb);
    if (sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!cfg) return NextResponse.json({ ok: false, error: "RRHH aún no configuró la sede. Avisa a Recursos Humanos." }, { status: 409 });

    // 2) Consentimiento biométrico vigente (la marcación guarda una foto = dato biométrico). Se
    //    mantiene como está; es independiente del consentimiento facial de la verificación 1:1.
    const { data: perfil, error: ePerfil } = await sb
      .from("empleado_perfil").select("*").eq("usuario_id", usuarioId).maybeSingle();
    if (ePerfil && tablaFaltante(ePerfil, "empleado_perfil")) {
      return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    }
    if (!consentimientoVigente(perfil, "biometrico")) {
      return NextResponse.json({
        ok: false,
        requiere_consentimiento: "biometrico",
        metodo_alterno: "pin",
        error: "Para marcar con la cámara (se guarda tu foto como evidencia) primero debes dar tu consentimiento biométrico en tu perfil. Mientras tanto, puedes marcar con PIN pidiéndoselo a Recursos Humanos.",
      }, { status: 403 });
    }

    // 3) ¿Está disponible la verificación facial 1:1? Lo está si se puede cifrar/descifrar la plantilla
    //    (TOKEN_ENCRYPTION_KEY presente) Y existe la tabla `rrhh_rostro_ref` (rrhh-03 corrida). Si no,
    //    se DEGRADA al comportamiento de hoy — el ÚNICO fail-open: nunca bloquear por infra ausente.
    const descriptorRaw: unknown = body.descriptor;
    const cifradoOk = cifradoDisponible();
    // `refCifrado` es el único signo de "hay referencia": string ⇒ existe plantilla; null ⇒ no hay
    // (o no se leyó). Guardarlo en una sola variable deja que TS lo estreche a `string` al verificar.
    let refCifrado: string | null = null;
    let tablaRostroFalta = false;

    if (cifradoOk) {
      const { data: ref, error: eRef } = await sb
        .from("rrhh_rostro_ref").select("descriptor_cifrado").eq("usuario_id", usuarioId).maybeSingle();
      if (eRef) {
        if (tablaFaltante(eRef, "rrhh_rostro_ref")) {
          tablaRostroFalta = true; // migración rrhh-03 sin correr → facial no disponible (degrada)
        } else {
          // Un error de lectura TRANSITORIO no es "infra ausente": NO se degrada (sería fail-open con
          // una referencia presente) ni se registra sin comparar. Se aborta; la persona reintenta o PIN.
          console.error("[rrhh/marcar] no se pudo leer rrhh_rostro_ref:", eRef);
          return NextResponse.json({
            ok: false,
            error: "No se pudo verificar tu rostro en este momento. Intenta de nuevo; si persiste, marca con PIN.",
          }, { status: 503 });
        }
      } else if (ref?.descriptor_cifrado) {
        refCifrado = String(ref.descriptor_cifrado);
      }
    }
    const facialDisponible = cifradoOk && !tablaRostroFalta;

    // 4) Puertas legales del facial (Ley 29733), antes de registrar nada. Solo si está disponible.
    let descriptor: number[] | null = null;
    if (facialDisponible) {
      // a) Consentimiento FACIAL específico (distinto del biométrico): sin él no se procesa la plantilla
      //    ni se verifica identidad. 403 + método alterno, SIN registrar la marca.
      if (!consentimientoVigente(perfil, "facial")) {
        return NextResponse.json({
          ok: false,
          requiere_consentimiento: "facial",
          metodo_alterno: "pin",
          error: "Para marcar verificando tu identidad con el rostro (se compara contra tu plantilla facial) primero debes dar tu consentimiento de verificación facial en tu perfil. Mientras tanto, puedes marcar con PIN pidiéndoselo a Recursos Humanos.",
        }, { status: 403 });
      }
      // b) Descriptor válido (128 números finitos). Si no, la cámara no captó bien: 422 REINTENTABLE
      //    (el frontend pide repetir la foto), NO un bloqueo, y distinto de "no coincide".
      if (!esDescriptorValido(descriptorRaw)) {
        return NextResponse.json({ ok: false, error: "no_se_detecto_rostro" }, { status: 422 });
      }
      descriptor = descriptorRaw; // ya narrowed a number[] por el type guard
    }

    // 5) Tipo del día: lo deriva el servidor. El cliente solo puede forzar el SIGUIENTE hito.
    const hoy = hoyLimaFecha();
    const previa = await marcasDeHoy(sb, usuarioId, hoy);
    if (previa.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    const sugerido = tipoSiguiente(previa.marcas);
    if (!sugerido) {
      return NextResponse.json({ ok: false, error: "Ya cerraste tu jornada de hoy." }, { status: 409 });
    }
    let tipo = sugerido;
    if (body.tipo != null) {
      if (!esTipoMarca(body.tipo)) {
        return NextResponse.json({ ok: false, error: "Tipo de marca inválido." }, { status: 400 });
      }
      if (body.tipo !== sugerido) {
        return NextResponse.json({
          ok: false, error: `Ahora te toca marcar "${sugerido}", no "${body.tipo}".`, siguiente: sugerido,
        }, { status: 409 });
      }
      tipo = body.tipo;
    }

    // 6) Geocerca: la MIDE el servidor con la config real, no el cliente.
    const lat = body.lat != null ? Number(body.lat) : null;
    const lng = body.lng != null ? Number(body.lng) : null;
    const precision_m = body.precision_m != null && Number.isFinite(Number(body.precision_m)) ? Number(body.precision_m) : null;
    const geo = validarMarca({ lat, lng, precision_m }, cfg);
    if (cfg.geocerca_bloquea && !geo.dentro_geocerca) {
      return NextResponse.json({
        ok: false, error: "Estás fuera del área de la sede. Acércate para marcar.",
        dentro_geocerca: false, distancia_m: Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      }, { status: 403 });
    }

    // 7) Decisión facial 1:1. Lo que NO puede pasar: registrar una marca con referencia presente sin
    //    que `decidirRostro` haya dado `coincide`. Un `no_coincide` nunca registra (nadie marca por otro).
    let rostroVerificado: boolean | null = null;
    let rostroDistancia: number | null = null;
    let debeEnrolar = false;
    if (facialDisponible) {
      if (refCifrado == null) {
        // Primera vez (o RRHH borró la referencia): esta plantilla pasa a ser la referencia. La marca
        // de enrolamiento NO verifica identidad (no hay contra qué comparar), así que `rostro_verificado`
        // queda en NULL: marcarla como verificada daría a RRHH una falsa señal de "verificado ✓" sobre
        // una marca que no comparó nada. El enrolamiento se distingue por `enrolado:true` en la respuesta
        // y por `rrhh_rostro_ref.enrolado_marca_id` (la foto queda para que RRHH la confirme).
        debeEnrolar = true;
      } else {
        const refDesc = deserializarDescriptor(descifrar(refCifrado));
        if (!refDesc) {
          // Referencia ILEGIBLE (clave rotada, dato corrompido): NUNCA se re-enrola en silencio (otra
          // persona podría pisar la plantilla) ni se registra sin comparar. Se aborta; lo arregla RRHH.
          console.error("[rrhh/marcar] referencia facial ilegible para el usuario", usuarioId);
          return NextResponse.json({
            ok: false,
            error: "rostro_referencia_ilegible",
            metodo_alterno: "pin",
            mensaje: "No se pudo leer tu plantilla facial guardada. Pide a Recursos Humanos que la vuelva a registrar; mientras tanto, marca con PIN.",
          }, { status: 409 });
        }
        const decision = decidirRostro(refDesc, descriptor);
        if (decision.codigo !== "coincide") {
          // La ÚNICA salida con referencia presente que registra es `coincide`. Todo lo demás
          // (`no_coincide`, y cualquier otro código defensivo) rechaza SIN registrar.
          return NextResponse.json({ ok: false, error: "rostro_no_coincide" }, { status: 403 });
        }
        rostroVerificado = true;
        rostroDistancia = typeof decision.distancia === "number" ? decision.distancia : null;
      }
    }

    // 8) Foto al bucket privado (re-encodeada sin EXIF/GPS). Un archivo inválido → 400; un fallo
    //    de Storage → se registra SIN foto (nunca se pierde la marca).
    let fotoPath: string | null = null;
    let fotoOmitida = false;
    if (body.foto) {
      try {
        fotoPath = await subirArrhh(sb, `marcas/${usuarioId}/${hoy}/${tipo}-${crypto.randomUUID()}`, body.foto, "foto");
      } catch (e) {
        if (e instanceof AdjuntoInvalido) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
        fotoOmitida = true;
      }
    } else {
      fotoOmitida = true;
    }

    // 9) Inserta la marca (degradando columnas accesorias; tabla ausente → 422). `rostro_verificado`/
    //    `rostro_distancia` se sueltan solos si rrhh-03 no corrió (en ese caso ya vienen en null).
    const fila: Record<string, unknown> = {
      usuario_id: usuarioId,
      tipo,
      lat, lng, precision_m,
      dentro_geocerca: geo.dentro_geocerca,
      distancia_m: Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      foto_url: fotoPath,
      rostro_detectado: body.rostro_detectado === true ? true : body.rostro_detectado === false ? false : null,
      rostro_verificado: rostroVerificado,
      rostro_distancia: rostroDistancia,
      metodo: "facial",
      origen: "web",
    };
    const ins = await escribirDegradando("rrhh_marca", fila, (f) =>
      sb.from("rrhh_marca").insert(f).select("*"));
    if (ins.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!ins.ok) return NextResponse.json({ ok: false, error: ins.error?.message ?? "No se pudo registrar la marca." }, { status: 500 });

    // 10) Enrolamiento: la marca YA quedó. Guardar la referencia es best-effort — si falla, la próxima
    //     marca re-enrola; ese fallo NUNCA tumba la marca ya registrada. Orden: marca → id → referencia.
    if (debeEnrolar && descriptor) {
      try {
        const serial = serializarDescriptor(descriptor);
        if (serial) {
          const { error: eUpsert } = await sb.from("rrhh_rostro_ref").upsert({
            usuario_id: usuarioId,
            descriptor_cifrado: cifrar(serial),
            foto_url: fotoPath,
            enrolado_marca_id: ins.data?.id ?? null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "usuario_id" });
          if (eUpsert) console.error("[rrhh/marcar] no se pudo guardar la plantilla facial:", eUpsert.message);
        }
      } catch (e) {
        console.error("[rrhh/marcar] enrolamiento facial falló (la marca ya quedó):", e);
      }
    }

    // 11) Jornada del día recalculada con la marca nueva incluida.
    const ahora = await marcasDeHoy(sb, usuarioId, hoy);
    const jornada = calcularJornada(ahora.marcas, cfg);

    return NextResponse.json({
      ok: true,
      tipo,
      dentro_geocerca: geo.dentro_geocerca,
      distancia_m: Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      foto_omitida: fotoOmitida,
      rostro_verificado: rostroVerificado,
      enrolado: debeEnrolar,
      jornada,
    });
  } catch (e: any) {
    console.error("[rrhh/marcar]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
