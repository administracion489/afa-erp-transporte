// app/api/campanas/probar/route.ts
// Envío de PRUEBA desde el 2do número (avisos). Sirve para verificar de punta a punta:
// que META_PHONE_NUMBER_ID_AVISOS esté bien, que META_WA_TOKEN tenga permiso sobre la
// WABA del número, y que la plantilla exista/esté aprobada.
// Por defecto usa `hello_world` (en), que Meta provisiona en toda cuenta nueva, así se
// puede probar ANTES de que aprueben las plantillas propias.

import { NextRequest, NextResponse } from "next/server";
import { enviarWhatsAppPlantilla, phoneCrm } from "@/lib/crm-meta";
import { phoneAvisos } from "@/lib/notificaciones";
import { verificarUsuarioApi } from "@/lib/api-auth";

/** Normaliza a formato Meta (solo dígitos, con código de país Perú). */
function normalizar(tel: string): string {
  const d = tel.replace(/\D/g, "");
  if (d.length === 9) return "51" + d;           // 905438216 → 51905438216
  return d;                                       // ya trae código de país
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { telefono, plantilla, idioma, parametros, numero } = await req.json();
    if (!telefono) return NextResponse.json({ error: "telefono requerido" }, { status: 400 });

    // Cuál de los 2 números oficiales usar:
    //   'avisos' → +51 905438216 (notificaciones)  |  'crm' → +51 966707225 (atención + campañas)
    const usarCrm  = numero === "crm";
    const phoneId  = usarCrm ? phoneCrm() : phoneAvisos();
    if (!phoneId) {
      return NextResponse.json(
        { error: usarCrm
            ? "Falta META_PHONE_NUMBER_ID (número del CRM) en las variables de entorno."
            : "Falta META_PHONE_NUMBER_ID_AVISOS (número de avisos) en las variables de entorno (Vercel)." },
        { status: 400 },
      );
    }

    const to = normalizar(String(telefono));
    const tpl = (plantilla || "hello_world").trim();
    // La plantilla de muestra "hello_world" que Meta precarga está en en_US, no en "en".
    const lang = (idioma || (tpl === "hello_world" ? "en_US" : "es")).trim();

    const id = await enviarWhatsAppPlantilla(to, tpl, lang, parametros ?? [], phoneId);
    return NextResponse.json({
      ok: true, enviadoA: to, plantilla: tpl, idioma: lang,
      desde: usarCrm ? "CRM (966707225)" : "Avisos (905438216)",
      phoneId, messageId: id,
    });
  } catch (e: any) {
    // Devolvemos el mensaje crudo de Meta: es lo que permite diagnosticar
    // (permisos del token sobre la WABA, plantilla inexistente, etc.).
    console.error("[campanas/probar]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
