// app/api/crm/whatsapp/activar/route.ts
//
// Cierra el Embedded Signup. El navegador manda aquí, EN EL ACTO, el `code` que
// Meta acaba de entregar; este endpoint hace todo lo que faltaba para que el
// número quede realmente utilizable:
//
//   1. canjea el código por el business token de la empresa   (¡vive 30 segundos!)
//   2. suscribe la app del ERP a los webhooks de ese WABA     (sin esto no llega nada)
//   3. verifica cómo quedó el número (coexistencia sí/no)
//   4. lo registra en `whatsapp_numeros`
//   5. guarda su token cifrado en `whatsapp_tokens`
//   6. en coexistencia: pide los contactos y hasta 6 meses de historial
//
// Antes de esto el modal solo IMPRIMÍA el código en pantalla ("guárdalo, aún falta
// activarlo"), así que ningún número llegaba nunca a completarse.
//
// Devuelve el detalle paso a paso — no un ok/error pelado — para que la pantalla
// muestre exactamente en cuál se atascó y qué hacer. Un fallo en un paso tardío
// (p. ej. la sincronización del historial) no invalida los anteriores: el número
// ya quedó conectado y solo se pierde el backfill.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { registrarNumero } from "@/lib/whatsapp-registro";
import { guardarToken, cifradoDisponible } from "@/lib/meta-tokens";
import {
  canjearCodigo,
  suscribirApp,
  verificarNumero,
  sincronizarDatosApp,
  type EstadoNumero,
} from "@/lib/meta-onboarding";

export const maxDuration = 60;

type EstadoPaso = "ok" | "error" | "omitido";
type Paso = { clave: string; titulo: string; estado: EstadoPaso; detalle?: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function POST(req: NextRequest) {
  // Conectar la cuenta de WhatsApp de la empresa es una acción de administración,
  // no de atención al cliente: se pide el módulo `configuracion` (admin siempre pasa).
  const auth = await verificarUsuarioApi(req, "configuracion");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}) as any);
  const code: string | undefined = body?.code;
  const phoneNumberId: string | undefined = body?.phone_number_id;
  const wabaId: string | undefined = body?.waba_id;
  const alias: string | undefined = body?.alias;
  // El modal manda true cuando el Embedded Signup terminó por la vía de
  // coexistencia (FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING).
  const esCoexistencia: boolean = body?.es_coexistencia !== false;

  if (!code) return NextResponse.json({ error: "Falta el código de autorización." }, { status: 400 });
  if (!phoneNumberId) return NextResponse.json({ error: "Falta phone_number_id." }, { status: 400 });

  const pasos: Paso[] = [];
  const avisos: string[] = [];
  const anotar = (clave: string, titulo: string, estado: EstadoPaso, detalle?: string) =>
    pasos.push({ clave, titulo, estado, detalle });

  // ── 1) Canje del código ──────────────────────────────────────────────────
  // Bloqueante: sin token no hay nada que hacer con los pasos siguientes.
  let token: string;
  let expiresIn: number | null = null;
  try {
    const r = await canjearCodigo(code);
    token = r.token;
    expiresIn = r.expiresIn;
    anotar("canje", "Canjear el código por el token de la cuenta", "ok");
  } catch (e) {
    anotar("canje", "Canjear el código por el token de la cuenta", "error", msg(e));
    return NextResponse.json({ ok: false, pasos, avisos, error: msg(e) }, { status: 502 });
  }

  // ── 2) Suscribir la app al WABA ──────────────────────────────────────────
  // No bloqueante para el registro, pero sí crítico: si falla no entra ningún
  // mensaje al Inbox, y conviene que quede dicho con esas palabras.
  if (wabaId) {
    try {
      await suscribirApp(wabaId, token);
      anotar("suscripcion", "Suscribir el ERP a los mensajes de la cuenta", "ok");
    } catch (e) {
      anotar("suscripcion", "Suscribir el ERP a los mensajes de la cuenta", "error", msg(e));
      avisos.push(
        "Sin esta suscripción los mensajes no entrarán al Inbox aunque el número aparezca conectado. " +
          "Se puede reintentar volviendo a conectar el número.",
      );
    }
  } else {
    anotar(
      "suscripcion",
      "Suscribir el ERP a los mensajes de la cuenta",
      "omitido",
      "Meta no devolvió el waba_id en este flujo.",
    );
  }

  // ── 3) Verificar el número ───────────────────────────────────────────────
  let estado: EstadoNumero | null = null;
  try {
    estado = await verificarNumero(phoneNumberId, token);
    const detalles = [
      estado.display_phone_number ? `número ${estado.display_phone_number}` : null,
      estado.platform_type ? `plataforma ${estado.platform_type}` : null,
      estado.is_on_biz_app === true
        ? "sigue activo en la app del celular (coexistencia)"
        : estado.is_on_biz_app === false
          ? "NO figura en la app del celular"
          : null,
    ].filter(Boolean);
    anotar("verificacion", "Verificar el número en Meta", "ok", detalles.join(" · "));

    // El caso que hay que cantar fuerte: se pidió coexistencia y no quedó en
    // coexistencia. El número funciona por API, pero el teléfono quedó fuera.
    if (esCoexistencia && estado.is_on_biz_app === false) {
      avisos.push(
        "Meta reporta que el número NO quedó en coexistencia (is_on_biz_app = false): funcionará por la API, " +
          "pero puede haber dejado de funcionar en la app WhatsApp Business del celular. Revísalo en el teléfono antes de seguir.",
      );
    }
  } catch (e) {
    anotar("verificacion", "Verificar el número en Meta", "error", msg(e));
  }

  // ── 4) Registrar el número ───────────────────────────────────────────────
  const registro = await registrarNumero({
    phone_number_id: phoneNumberId,
    waba_id: wabaId ?? null,
    alias: alias ?? estado?.verified_name ?? null,
    display_phone_number: estado?.display_phone_number ?? null,
    extra: {
      es_coexistencia: esCoexistencia && estado?.is_on_biz_app !== false,
      is_on_biz_app: estado?.is_on_biz_app ?? null,
      platform_type: estado?.platform_type ?? null,
      onboarding_estado: "activo",
      onboarding_en: new Date().toISOString(),
      onboarding_detalle: null,
    },
  });

  if (!registro.ok) {
    anotar("registro", "Registrar el número en el ERP", "error", registro.error);
    return NextResponse.json({ ok: false, pasos, avisos, error: registro.error }, { status: 500 });
  }
  anotar(
    "registro",
    "Registrar el número en el ERP",
    "ok",
    registro.creado ? `Alta nueva: "${registro.numero?.alias}"` : `Actualizado: "${registro.numero?.alias}"`,
  );

  // Los usos NO se asignan solos (ver lib/whatsapp-registro.ts): sin uso, el
  // número recibe pero no envía, y eso sorprende si nadie lo dice.
  const sinUso =
    !registro.numero?.usa_crm && !registro.numero?.usa_avisos && !registro.numero?.usa_campanas;
  if (sinUso) {
    avisos.push(
      'El número quedó registrado SIN uso asignado: recibirá mensajes, pero no saldrá ninguno por él. ' +
        'Asígnale "Atención", "Avisos" o "Campañas" en Configuración para que pueda enviar.',
    );
  }

  // ── 5) Guardar el token de la empresa ────────────────────────────────────
  const guardado = await guardarToken({
    phoneNumberId,
    wabaId: wabaId ?? null,
    token,
    expiresIn,
  });
  if (guardado.ok) {
    anotar("token", "Guardar el token de la cuenta (cifrado)", "ok");
  } else {
    anotar(
      "token",
      "Guardar el token de la cuenta (cifrado)",
      cifradoDisponible() ? "error" : "omitido",
      guardado.aviso,
    );
    if (guardado.aviso) avisos.push(guardado.aviso);
  }

  // ── 6) Sincronizaciones de la coexistencia ───────────────────────────────
  // Los datos llegan luego por webhook, no en estas respuestas. Y Meta solo
  // acepta pedirlos dentro de las 24 h del onboarding, así que se piden ya.
  const marcas: Record<string, string> = {};
  if (esCoexistencia) {
    try {
      await sincronizarDatosApp(phoneNumberId, token, "smb_app_state_sync");
      marcas.contactos_solicitados_en = new Date().toISOString();
      anotar("contactos", "Pedir los contactos del celular", "ok", "Llegarán por webhook en unos minutos.");
    } catch (e) {
      anotar("contactos", "Pedir los contactos del celular", "error", msg(e));
    }

    try {
      await sincronizarDatosApp(phoneNumberId, token, "history");
      marcas.historial_solicitado_en = new Date().toISOString();
      anotar(
        "historial",
        "Pedir el historial de conversaciones (hasta 6 meses)",
        "ok",
        "Llegará por webhook; en cuentas con mucho tráfico puede tardar.",
      );
    } catch (e) {
      anotar("historial", "Pedir el historial de conversaciones (hasta 6 meses)", "error", msg(e));
      avisos.push(
        "Meta solo acepta pedir el historial dentro de las 24 h siguientes a conectar el número. " +
          "Si el plazo venció, hay que desconectar el número y volver a conectarlo para recuperarlo.",
      );
    }

    if (Object.keys(marcas).length > 0) {
      const db = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      // Best-effort: si las columnas aún no existen (migración sin correr), el
      // número ya quedó conectado igual. Solo se pierde la marca de tiempo.
      await db.from("whatsapp_numeros").update(marcas).eq("phone_number_id", phoneNumberId);
    }
  } else {
    anotar("contactos", "Pedir los contactos del celular", "omitido", "Solo aplica a la coexistencia.");
    anotar("historial", "Pedir el historial de conversaciones", "omitido", "Solo aplica a la coexistencia.");
  }

  const huboError = pasos.some((p) => p.estado === "error");
  return NextResponse.json({
    ok: !huboError,
    pasos,
    avisos,
    numero: registro.numero,
  });
}
