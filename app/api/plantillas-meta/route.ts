// app/api/plantillas-meta/route.ts
// Editor de plantillas WhatsApp DESDE el ERP (sin entrar a WhatsApp Manager).
//   GET  ?numero=avisos|crm         → lista plantillas con su texto (BODY) y estado.
//   POST { numero, id, body }       → edita el TEXTO del cuerpo de una plantilla.
//
// Reglas de Meta que este endpoint respeta y hace cumplir:
//   • Editar una plantilla la manda a RE-REVISIÓN (minutos a horas); mientras esté
//     "PENDING" ese aviso no puede enviarse. No es evitable — es regla de WhatsApp.
//   • Las variables {{n}} NO pueden cambiar aquí (el código envía los datos en ese
//     orden exacto): se valida que el nuevo texto tenga las MISMAS variables.
//   • Los botones/encabezados existentes se conservan tal cual; solo cambia el cuerpo.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";

const GRAPH = "https://graph.facebook.com/v25.0";

const WABA: Record<string, string> = {
  crm:    "428943170988671",   // Afa Transporte (clientes/campañas, +51 966707225)
  avisos: "1336334522036982",  // Afa Notificaciones (+51 905438216)
};

function extraerVars(texto: string): string[] {
  return [...new Set((texto.match(/\{\{\s*\d+\s*\}\}/g) ?? []).map((v) => v.replace(/\s/g, "")))].sort();
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "configuracion");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const numero = req.nextUrl.searchParams.get("numero") === "crm" ? "crm" : "avisos";
  const token = process.env.META_WA_TOKEN;
  if (!token) return NextResponse.json({ error: "META_WA_TOKEN no configurado" }, { status: 400 });

  try {
    const res = await fetch(
      `${GRAPH}/${WABA[numero]}/message_templates?fields=id,name,status,language,category,components&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data.error?.message ?? "Error Meta" }, { status: 500 });

    const plantillas = (data.data ?? []).map((t: any) => {
      const body = (t.components ?? []).find((c: any) => c.type === "BODY");
      return {
        id: t.id, name: t.name, status: t.status, language: t.language, category: t.category,
        body: body?.text ?? "", vars: extraerVars(body?.text ?? "").length,
        botones: ((t.components ?? []).find((c: any) => c.type === "BUTTONS")?.buttons ?? []).length,
      };
    });
    return NextResponse.json({ numero, plantillas });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "configuracion");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const token = process.env.META_WA_TOKEN;
  if (!token) return NextResponse.json({ error: "META_WA_TOKEN no configurado" }, { status: 400 });

  const payload = await req.json();

  // ── Crear una plantilla NUEVA (p.ej. conductor_recuerda_checkout) ───────────
  // POST { accion:"crear", numero, name, category, body, ejemplos: string[], boton?: {texto,url} }
  // `ejemplos` trae un valor de muestra por cada {{n}} del cuerpo, en el mismo orden
  // (Meta los exige para poder mandar la plantilla a revisión). `boton` es un botón de
  // enlace ESTÁTICO (misma URL para todos los envíos, sin variable): no requiere pasar
  // parámetros extra al enviar el aviso (a diferencia de los botones dinámicos que ya usa
  // recordatorio_conductor, esos sí llevan {{1}} y se arman en lib/notificaciones.ts).
  if (payload.accion === "crear") {
    const numero = payload.numero === "crm" ? "crm" : "avisos";
    const name = String(payload.name ?? "").trim().toLowerCase();
    const category = payload.category === "MARKETING" ? "MARKETING" : "UTILITY";
    const bodyTexto = String(payload.body ?? "").trim();
    const ejemplos = Array.isArray(payload.ejemplos) ? payload.ejemplos.map((e: any) => String(e)) : [];
    const boton = payload.boton && String(payload.boton.texto ?? "").trim() && String(payload.boton.url ?? "").trim()
      ? { texto: String(payload.boton.texto).trim().slice(0, 25), url: String(payload.boton.url).trim() }
      : null;

    if (!/^[a-z0-9_]{1,512}$/.test(name)) {
      return NextResponse.json({ error: "El nombre solo puede tener minúsculas, números y guion bajo (_), sin espacios" }, { status: 400 });
    }
    if (!bodyTexto) return NextResponse.json({ error: "El cuerpo del mensaje es obligatorio" }, { status: 400 });
    if (boton && !/^https?:\/\//i.test(boton.url)) {
      return NextResponse.json({ error: "La URL del botón debe empezar con http:// o https://" }, { status: 400 });
    }

    const vars = extraerVars(bodyTexto);
    if (vars.length !== ejemplos.filter((e: string) => e.trim()).length) {
      return NextResponse.json({
        error: `Faltan ejemplos: la plantilla usa ${vars.length} variable(s) (${vars.join(" ") || "ninguna"}) y llegaron ${ejemplos.length} ejemplo(s).`,
      }, { status: 400 });
    }

    const components: any[] = [
      { type: "BODY", text: bodyTexto, ...(vars.length ? { example: { body_text: [ejemplos] } } : {}) },
      ...(boton ? [{ type: "BUTTONS", buttons: [{ type: "URL", text: boton.texto, url: boton.url }] }] : []),
    ];

    try {
      const rCrear = await fetch(`${GRAPH}/${WABA[numero]}/message_templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, language: "es", category, components }),
      });
      const resCrear = await rCrear.json();
      if (!rCrear.ok) {
        return NextResponse.json({ error: resCrear.error?.error_user_msg || resCrear.error?.message || "Error al crear la plantilla" }, { status: 500 });
      }
      return NextResponse.json({
        ok: true,
        id: resCrear.id,
        mensaje: `Plantilla "${name}" enviada a revisión de Meta (estado: ${resCrear.status || "PENDING"}). Mientras esté en revisión no se puede enviar; al aprobarse (minutos a horas) empieza a funcionar sola.`,
      });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  // ── Editar el TEXTO de una plantilla EXISTENTE (comportamiento previo) ──────
  try {
    const { id, body } = payload;
    if (!id || !body?.trim()) return NextResponse.json({ error: "id y body requeridos" }, { status: 400 });

    // 1) Traer la plantilla actual (para conservar botones/ejemplos y validar variables).
    const rGet = await fetch(
      `${GRAPH}/${id}?fields=id,name,status,category,language,components`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const actual = await rGet.json();
    if (!rGet.ok) return NextResponse.json({ error: actual.error?.message ?? "Plantilla no encontrada" }, { status: 404 });

    const comps: any[] = actual.components ?? [];
    const bodyComp = comps.find((c) => c.type === "BODY");
    if (!bodyComp) return NextResponse.json({ error: "La plantilla no tiene cuerpo editable" }, { status: 400 });

    // 2) Validar que las variables NO cambien (el código depende del orden/cantidad).
    const varsViejas = extraerVars(bodyComp.text ?? "");
    const varsNuevas = extraerVars(body);
    if (JSON.stringify(varsViejas) !== JSON.stringify(varsNuevas)) {
      return NextResponse.json({
        error: `Las variables deben mantenerse iguales. La plantilla usa: ${varsViejas.join(" ") || "(ninguna)"} y tu texto tiene: ${varsNuevas.join(" ") || "(ninguna)"}. Cambia el texto alrededor de las variables, no las variables.`,
      }, { status: 400 });
    }

    // 3) Reenviar los componentes con el cuerpo nuevo (conservando ejemplo y botones).
    const nuevos = comps.map((c) => (c.type === "BODY" ? { ...c, text: body } : c));
    const rEdit = await fetch(`${GRAPH}/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ components: nuevos }),
    });
    const resEdit = await rEdit.json();
    if (!rEdit.ok) return NextResponse.json({ error: resEdit.error?.error_user_msg || resEdit.error?.message || "Error al editar" }, { status: 500 });

    return NextResponse.json({
      ok: true,
      mensaje: "Enviado a revisión de Meta. Mientras esté en revisión, este aviso no se puede enviar; al aprobarse vuelve a funcionar solo.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
