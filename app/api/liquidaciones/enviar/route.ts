// POST /api/liquidaciones/enviar — manda la liquidación para su conformidad.
//
// Tres canales, un mismo enlace: correo (Resend), WhatsApp (plantilla Meta) y el
// Portal del Cliente. Todos llevan al cliente a /conformidad/<token>, donde ve el
// mismo documento y aprueba u observa. Si se enviara un PDF distinto por cada canal
// volveríamos al problema de raíz: varias versiones del mismo papel circulando.
//
// Cada intento queda en `liquidacion_envio` (canal, destino, resultado). Cuando el
// cliente diga "nunca me llegó", la respuesta está ahí.

import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { enviarEmail, enviarAvisoWhatsApp } from "@/lib/notificaciones";
import { fmtMoneda } from "@/lib/finanzas/dinero";

export const dynamic = "force-dynamic";

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * Plantilla de WhatsApp que hay que crear y aprobar en el WhatsApp Manager de Meta
 * (categoría "utility"). Variables del cuerpo, EN ESTE ORDEN:
 *   {{1}} nombre del contacto
 *   {{2}} cliente / sede
 *   {{3}} periodo valorizado
 *   {{4}} importe total
 *   {{5}} código de la liquidación
 * Botón URL DINÁMICO: su {{1}} se rellena con el token del enlace de conformidad.
 * Mientras no esté aprobada, el envío automático falla y queda registrado como
 * fallido — para eso el modal ofrece además el enlace wa.me listo para pegar.
 */
export const PLANTILLA_WA = "liquidacion_conformidad";

const BASE = () =>
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
  process.env.APP_URL?.replace(/\/$/, "") ||
  "https://afatoursperu.com";

function htmlCorreo(d: {
  contacto: string; empresa: string; sede: string; periodo: string; codigo: string;
  total: string; url: string; servicios: number; emisor: string;
}): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)">
        <tr><td style="background:#0b315f;padding:20px 24px">
          <p style="margin:0;color:#fff;font-size:17px;font-weight:900">Liquidación del servicio</p>
          <p style="margin:4px 0 0;color:rgba(255,255,255,.72);font-size:12px">${d.codigo} · ${d.periodo}</p>
        </td></tr>
        <tr><td style="padding:24px">
          <p style="margin:0 0 14px;font-size:14px;color:#334155">Estimado(a) <b>${d.contacto}</b>:</p>
          <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6">
            Ponemos a su disposición la liquidación de los servicios de transporte prestados a
            <b>${d.empresa}</b>${d.sede ? ` — ${d.sede}` : ""} durante el periodo <b>${d.periodo}</b>,
            para su revisión y conformidad.
          </p>
          <table width="100%" style="border:1px solid #e2e8f0;border-radius:10px;margin:0 0 18px">
            <tr><td style="padding:10px 14px;font-size:13px;color:#64748b">Servicios ejecutados</td>
                <td style="padding:10px 14px;font-size:13px;color:#0f172a;font-weight:700;text-align:right">${d.servicios}</td></tr>
            <tr><td style="padding:10px 14px;font-size:13px;color:#64748b;border-top:1px solid #e2e8f0">Total a facturar</td>
                <td style="padding:10px 14px;font-size:15px;color:#0b315f;font-weight:900;text-align:right;border-top:1px solid #e2e8f0">${d.total}</td></tr>
          </table>
          <p style="text-align:center;margin:0 0 18px">
            <a href="${d.url}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:13px 30px;border-radius:10px;font-weight:900;font-size:14px">
              Revisar y dar conformidad
            </a>
          </p>
          <p style="margin:0 0 6px;font-size:12px;color:#64748b;line-height:1.6">
            En ese enlace podrá ver el detalle servicio por servicio (fecha, unidad, conductor y horas reales),
            descargar el formato en PDF y registrar su conformidad u observación. No necesita usuario ni contraseña.
          </p>
          <p style="margin:14px 0 0;font-size:11px;color:#94a3b8;word-break:break-all">${d.url}</p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e2e8f0">
          <p style="margin:0;font-size:11px;color:#94a3b8">Enviado por ${d.emisor} · AFA Tours Perú S.A.C.</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

export async function POST(req: Request) {
  const auth = await verificarUsuarioApi(req, "liquidaciones");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const body = await req.json();
    const lado: "cliente" | "proveedor" = body.lado === "proveedor" ? "proveedor" : "cliente";
    const id = Number(body.id);
    const canales: string[] = Array.isArray(body.canales) ? body.canales : ["correo"];
    const destinos = body.destinos ?? {};
    if (!id) return Response.json({ error: "Falta el id de la liquidación" }, { status: 400 });

    const sb = admin();
    const tabla = lado === "cliente" ? "liquidacion_cliente" : "liquidacion_proveedor";
    const { data: liq } = await sb.from(tabla).select("*").eq("id", id).maybeSingle();
    if (!liq) return Response.json({ error: "La liquidación no existe" }, { status: 404 });
    if (liq.estado === "borrador")
      return Response.json({ error: "Primero emite el documento: un borrador no se envía." }, { status: 400 });
    if (liq.estado === "anulada")
      return Response.json({ error: "La liquidación está anulada." }, { status: 400 });

    // Datos para el mensaje.
    const [contraparteR, sedeR] = await Promise.all([
      lado === "cliente"
        ? sb.from("clientes").select("nombre,empresa,email,administrativo_nombre,administrativo_email,administrativo_celular").eq("id", liq.cliente_id).maybeSingle()
        : sb.from("empresas_tercerizadas").select("razon_social,email,contacto_nombre,contacto_telefono").eq("id", liq.empresa_tercerizada_id).maybeSingle(),
      liq.cliente_sede_id
        ? sb.from("cliente_sedes").select("*").eq("id", liq.cliente_sede_id).maybeSingle()
        : Promise.resolve({ data: null as any }),
    ]);
    // Las dos consultas devuelven formas distintas (clientes vs empresas_tercerizadas);
    // el resto del código elige campo según el lado, así que se leen como `any`.
    const cp: any = contraparteR?.data ?? {};
    const sede: any = sedeR?.data ?? null;

    const empresa = lado === "cliente" ? (cp?.empresa || cp?.nombre || "") : (cp?.razon_social || "");
    const contacto =
      destinos.contacto ||
      sede?.usuario_solicita ||
      (lado === "cliente" ? cp?.administrativo_nombre : cp?.contacto_nombre) ||
      "estimado cliente";
    const correo =
      destinos.correo || sede?.email_conformidad || (lado === "cliente" ? cp?.administrativo_email || cp?.email : cp?.email);
    const whatsapp =
      destinos.whatsapp || sede?.whatsapp_conformidad || (lado === "cliente" ? cp?.administrativo_celular : cp?.contacto_telefono);

    const url = `${BASE()}/conformidad/${liq.token}`;
    const total = fmtMoneda(Number(liq.total ?? 0), liq.moneda ?? "PEN");

    // Cuántos servicios cubre (para el resumen del mensaje).
    const tLin = lado === "cliente" ? "liquidacion_cliente_linea" : "liquidacion_proveedor_linea";
    const tPue = lado === "cliente" ? "liquidacion_cliente_linea_reserva" : "liquidacion_proveedor_linea_reserva";
    const { data: lineas } = await sb.from(tLin).select("id").eq("liquidacion_id", id);
    const lineaIds = ((lineas as any[]) ?? []).map((l) => l.id);
    let servicios = 0;
    if (lineaIds.length) {
      const { count } = await sb.from(tPue).select("id", { count: "exact", head: true }).in("linea_id", lineaIds);
      servicios = count ?? 0;
    }

    const resultados: { canal: string; ok: boolean; destino: string | null; error?: string }[] = [];

    const registrar = async (canal: string, destino: string | null, ok: boolean, detalle?: string) => {
      resultados.push({ canal, ok, destino, error: ok ? undefined : detalle });
      await sb.from("liquidacion_envio").insert({
        entidad: lado, liquidacion_id: id, canal,
        destino, destinatario: contacto,
        estado: ok ? "enviado" : "fallido", detalle: detalle ?? null,
        enviado_por: auth.userId,
      });
    };

    // ── Correo ──────────────────────────────────────────────────────────────
    if (canales.includes("correo")) {
      if (!correo) await registrar("correo", null, false, "La sede no tiene correo de conformidad configurado");
      else {
        try {
          await enviarEmail({
            to: correo,
            subject: `Liquidación ${liq.codigo} · ${empresa}${sede?.nombre ? " — " + sede.nombre : ""} · ${liq.periodo ?? ""}`,
            html: htmlCorreo({
              contacto, empresa, sede: sede?.nombre ?? "", periodo: liq.periodo ?? "",
              codigo: liq.codigo ?? `#${id}`, total, url, servicios, emisor: "AFA Tours",
            }),
          });
          await registrar("correo", correo, true);
        } catch (e: any) {
          await registrar("correo", correo, false, String(e?.message ?? e));
        }
      }
    }

    // ── WhatsApp ────────────────────────────────────────────────────────────
    if (canales.includes("whatsapp")) {
      if (!whatsapp) await registrar("whatsapp", null, false, "La sede no tiene WhatsApp de conformidad configurado");
      else {
        const r = await enviarAvisoWhatsApp(whatsapp, PLANTILLA_WA, [
          String(contacto), `${empresa}${sede?.nombre ? " — " + sede.nombre : ""}`,
          String(liq.periodo ?? ""), total, String(liq.codigo ?? `#${id}`),
        ]);
        await registrar("whatsapp", whatsapp, r.ok, r.error);
      }
    }

    // ── Portal del Cliente ──────────────────────────────────────────────────
    // No hay nada que "enviar": el portal lee las liquidaciones emitidas del cliente.
    // Se registra igual para que el historial muestre que quedó publicada.
    if (canales.includes("portal")) await registrar("portal", null, true, "Publicada en el Portal del Cliente");

    const algunoOk = resultados.some((r) => r.ok);
    if (algunoOk) {
      await sb.from(tabla).update({ enviada_at: new Date().toISOString() }).eq("id", id);
      await sb.from("liquidacion_evento").insert({
        entidad: lado, liquidacion_id: id, evento: "enviada",
        detalle: resultados.filter((r) => r.ok).map((r) => r.canal).join(", "),
        usuario: auth.userId,
      });
    }

    return Response.json({ ok: algunoOk, resultados, url });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
