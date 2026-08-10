// lib/proveedor-documentos.ts
// Autoservicio de documentos para Empresas Tercerizadas (proveedores).
//
// Piezas:
//   · Cálculo de vencimiento (duplica estadoDoc/diasPara de app/tercerizadas/page.tsx — ese
//     archivo es "use client" y no se puede importar desde el cron/servidor).
//   · Token de acceso al formulario público (proveedor_tokens): uno vigente por empresa.
//   · Armado + envío del aviso (correo Resend + WhatsApp por plantilla) cuando un documento
//     obligatorio entra en ventana de vencimiento.
//
// Lo que el proveedor SUBE en /proveedor/[token] no toca documentos_tercero: cae en
// documentos_tercero_revisiones (estado "pendiente") y un operador lo aprueba desde
// /tercerizadas. Mientras no se apruebe, el ERP sigue viendo el documento viejo como
// vencido/por vencer — ver supabase/proveedor-documentos-autoservicio.sql.

import { enviarEmail, enviarAvisoWhatsApp } from "@/lib/notificaciones";

// ─── TIPOS OBLIGATORIOS ─────────────────────────────────────────────────────────
// DEBE coincidir con TIPOS_DOC_TERCERO (obligatorio:true) en app/tercerizadas/page.tsx —
// mismo trade-off que MODULOS en /api/crear-usuario vs. menuGrupos del layout: dos listas
// independientes por vivir en lados (cliente/servidor) que no se importan entre sí.
export const TIPOS_DOC_OBLIGATORIOS = [
  "SOAT",
  "Revisión Técnica (CITV)",
  "Habilitación SUTRAN",
  "Permiso Operación MTC",
  "Tarjeta de Propiedad",
  "SCTR Salud",
  "SCTR Pensión",
];

// ─── FECHAS / ESTADO ─────────────────────────────────────────────────────────────

export function diasPara(f: string | null | undefined): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

export type EstadoDoc = "vigente" | "por_vencer" | "vencido" | "sin_fecha";

export function estadoDoc(f: string | null | undefined): EstadoDoc {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0) return "vencido";
  if (d <= 30) return "por_vencer";
  return "vigente";
}

// "Día gatillo": para no mandar un correo distinto cada día mientras algo está por vencer,
// solo se avisa en hitos concretos (30/15/7/3/1/0 días antes) y, si ya venció, cada 7 días.
export function esDiaGatillo(dias: number): boolean {
  if (dias >= 0) return [30, 15, 7, 3, 1, 0].includes(dias);
  return Math.abs(dias) % 7 === 0;
}

// ─── TOKEN DE ACCESO ──────────────────────────────────────────────────────────────

const DIAS_VIGENCIA_TOKEN = 30;

function generarToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/** Token vigente para la empresa: reutiliza el último si no expiró, si no crea uno nuevo. */
export async function tokenVigentePara(admin: any, empresaId: number): Promise<string> {
  const { data: vigente } = await admin
    .from("proveedor_tokens")
    .select("token, expira_en")
    .eq("empresa_id", empresaId)
    .gt("expira_en", new Date().toISOString())
    .order("creado_en", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vigente?.token) return vigente.token;

  const token = generarToken();
  const expira = new Date(Date.now() + DIAS_VIGENCIA_TOKEN * 86400000).toISOString();
  await admin.from("proveedor_tokens").insert({ empresa_id: empresaId, token, expira_en: expira });
  return token;
}

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.transportesafa.com").replace(/\/$/, "");

export function linkProveedor(token: string): string {
  return `${APP_URL}/proveedor/${token}`;
}

// ─── DOCUMENTOS POR VENCER DE UNA EMPRESA ────────────────────────────────────────

export type ItemVencimiento = {
  claveDoc: string;           // "doc:<id>" | "auth_mtc" | "hab_sutran" — dedupe del aviso
  documentoId: number | null;
  vehiculoId: number | null;
  vehiculoPlaca: string | null;
  tipo: string;
  fechaVencimiento: string;
  dias: number;
  estado: "por_vencer" | "vencido";
};

/** Junta, para UNA empresa, los documentos obligatorios (propios + por unidad) y las
 *  habilitaciones MTC/SUTRAN que están vencidos o por vencer (≤30 días). */
export async function documentosPorVencerDeEmpresa(admin: any, empresa: {
  id: number; venc_autorizacion?: string | null; venc_habilitacion?: string | null;
}): Promise<ItemVencimiento[]> {
  const items: ItemVencimiento[] = [];

  const { data: docs } = await admin
    .from("documentos_tercero")
    .select("id, vehiculo_id, tipo, fecha_vencimiento")
    .eq("empresa_id", empresa.id)
    .not("fecha_vencimiento", "is", null)
    .in("tipo", TIPOS_DOC_OBLIGATORIOS);

  const vehIds = [...new Set((docs || []).map((d: any) => d.vehiculo_id).filter(Boolean))];
  const placaPorVeh: Record<number, string> = {};
  if (vehIds.length) {
    const { data: vehs } = await admin.from("vehiculos_tercero").select("id, placa").in("id", vehIds);
    for (const v of vehs || []) placaPorVeh[v.id] = v.placa;
  }

  for (const d of docs || []) {
    const est = estadoDoc(d.fecha_vencimiento);
    if (est !== "por_vencer" && est !== "vencido") continue;
    items.push({
      claveDoc: `doc:${d.id}`, documentoId: d.id, vehiculoId: d.vehiculo_id,
      vehiculoPlaca: d.vehiculo_id ? placaPorVeh[d.vehiculo_id] ?? null : null,
      tipo: d.tipo, fechaVencimiento: d.fecha_vencimiento,
      dias: diasPara(d.fecha_vencimiento)!, estado: est,
    });
  }

  for (const h of [
    { clave: "auth_mtc", tipo: "Autorización MTC", f: empresa.venc_autorizacion },
    { clave: "hab_sutran", tipo: "Habilitación SUTRAN (empresa)", f: empresa.venc_habilitacion },
  ]) {
    const est = estadoDoc(h.f);
    if (est !== "por_vencer" && est !== "vencido") continue;
    items.push({
      claveDoc: h.clave, documentoId: null, vehiculoId: null, vehiculoPlaca: null,
      tipo: h.tipo, fechaVencimiento: h.f!, dias: diasPara(h.f)!, estado: est,
    });
  }

  return items;
}

// ─── AVISO AL PROVEEDOR (correo + WhatsApp) ──────────────────────────────────────
// Plantilla de WhatsApp: se crea y aprueba en el WhatsApp Manager de Meta (mismo requisito
// que PLANTILLA_INVITACION en lib/pasajero-invitacion.ts). Variables del cuerpo, EN ESTE
// ORDEN: {{1}} nombre de contacto/empresa, {{2}} cantidad de documentos, {{3}} link (texto
// plano — WhatsApp lo vuelve tocable solo, no hace falta botón dinámico).
export const PLANTILLA_DOC_PROVEEDOR = "documentos_proveedor_vencer";

function nombreContacto(empresa: { contacto_nombre?: string | null; razon_social: string }): string {
  return empresa.contacto_nombre?.trim() || empresa.razon_social;
}

function filaItem(it: ItemVencimiento): string {
  const unidad = it.vehiculoPlaca ? it.vehiculoPlaca : "Empresa (general)";
  const venc = it.estado === "vencido"
    ? `<b style="color:#991b1b;">Vencido hace ${Math.abs(it.dias)} d</b>`
    : `<b style="color:#854d0e;">Vence en ${it.dias} d</b>`;
  const bg = it.estado === "vencido" ? "#fee2e2" : "#fffbeb";
  return `<tr style="background:${bg};">
    <td style="padding:8px 10px;font-weight:700;color:#0b315f;border-bottom:1px solid #e5e7eb;">${it.tipo}</td>
    <td style="padding:8px 10px;font-family:monospace;color:#374151;border-bottom:1px solid #e5e7eb;">${unidad}</td>
    <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${new Date(it.fechaVencimiento + "T00:00:00").toLocaleDateString("es-PE")}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e5e7eb;">${venc}</td>
  </tr>`;
}

function htmlAvisoProveedor(empresa: { razon_social: string }, items: ItemVencimiento[], link: string): string {
  const filas = items.map(filaItem).join("");
  const empresaNombre = process.env.EMPRESA_NOMBRE ?? "AFA Transportes";
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#eef2f7;margin:0;padding:24px 16px;">
<div style="max-width:640px;margin:0 auto;">
  <div style="background:#0b315f;border-radius:16px 16px 0 0;padding:24px;text-align:center;">
    <h1 style="color:white;margin:0;font-size:20px;font-weight:700;">📄 Documentos por actualizar</h1>
    <p style="color:#93c5fd;margin:6px 0 0;font-size:12px;">${empresa.razon_social}</p>
  </div>
  <div style="background:white;padding:24px;border-radius:0 0 16px 16px;">
    <p style="color:#475569;font-size:14px;margin:0 0 16px;">
      ${items.length} documento${items.length > 1 ? "s" : ""} de su flota está${items.length > 1 ? "n" : ""}
      vencido${items.length > 1 ? "s" : ""} o por vencer. Súbalo${items.length > 1 ? "s" : ""} actualizado${items.length > 1 ? "s" : ""}
      desde el siguiente enlace — un operador de ${empresaNombre} lo revisará antes de darlo por actualizado:
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f1f5f9;">
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Documento</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Unidad</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Vencimiento</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Estado</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div style="text-align:center;margin:24px 0 8px;">
      <a href="${link}" style="background:#0b315f;color:white;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px;display:inline-block;">Subir documentos actualizados</a>
    </div>
    <p style="color:#94a3b8;font-size:11px;margin:18px 0 0;">Mensaje automático de ${empresaNombre} · No responder</p>
  </div>
</div></body></html>`;
}

export type ResultadoAvisoProveedor = {
  email: "enviado" | "error" | "sin_canal";
  whatsapp: "enviado" | "error" | "sin_canal";
};

/** Manda el aviso agrupado (todos los items de una empresa en un solo correo/WhatsApp) y
 *  registra cada item en documentos_tercero_avisos para el dedupe del cron. No lanza. */
export async function enviarAvisoProveedor(
  admin: any,
  empresa: { id: number; razon_social: string; email?: string | null; contacto_telefono?: string | null; telefono?: string | null; contacto_nombre?: string | null },
  items: ItemVencimiento[],
): Promise<ResultadoAvisoProveedor> {
  const token = await tokenVigentePara(admin, empresa.id);
  const link = linkProveedor(token);
  const res: ResultadoAvisoProveedor = { email: "sin_canal", whatsapp: "sin_canal" };

  if (empresa.email?.trim()) {
    try {
      await enviarEmail({
        to: empresa.email.trim(),
        subject: `📄 ${items.length} documento${items.length > 1 ? "s" : ""} por actualizar — ${empresa.razon_social}`,
        html: htmlAvisoProveedor(empresa, items, link),
      });
      res.email = "enviado";
    } catch { res.email = "error"; }
  }

  const tel = empresa.contacto_telefono?.trim() || empresa.telefono?.trim();
  if (tel) {
    const r = await enviarAvisoWhatsApp(tel, PLANTILLA_DOC_PROVEEDOR, [
      nombreContacto(empresa), String(items.length), link,
    ]);
    res.whatsapp = r.ok ? "enviado" : "error";
  }

  const canal = res.email === "enviado" ? "email" : res.whatsapp === "enviado" ? "whatsapp" : "email";
  const estadoLog = res.email === "enviado" || res.whatsapp === "enviado" ? "enviado" : "sin_canal";
  await admin.from("documentos_tercero_avisos").insert(items.map(it => ({
    empresa_id: empresa.id, clave_doc: it.claveDoc, fecha_vencimiento: it.fechaVencimiento,
    dias_para_vencer: it.dias, canal, estado: estadoLog,
    detalle: `email:${res.email} whatsapp:${res.whatsapp}`,
  })));

  return res;
}
