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
import { docSinVencimiento, etiquetaTipoDoc, tipoCanonico, tiposObligatorios } from "@/lib/documentos-estado";

// ─── TIPOS OBLIGATORIOS ─────────────────────────────────────────────────────────
// Ya NO es una copia a mano de app/tercerizadas/page.tsx: se DERIVA del catálogo único de
// lib/documentos-estado.ts, que es un módulo puro (sin React) y por tanto sí se puede
// importar desde el cron. La copia se mantuvo mientras el catálogo no existía; hoy solo
// sería una lista más que se desincroniza — y la primera prueba fue este mismo cambio: al
// renombrar "Habilitación SUTRAN" a TUC, la copia habría dejado de pedirle al proveedor el
// documento con el que se sube a la carretera, en silencio y sin que nada fallara.
export const TIPOS_DOC_OBLIGATORIOS = tiposObligatorios(true).map((t) => t.canonico);

// ─── FECHAS / ESTADO ─────────────────────────────────────────────────────────────

export function diasPara(f: string | null | undefined): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

export type EstadoDoc = "vigente" | "por_vencer" | "vencido" | "sin_fecha" | "sin_vencimiento";

/** Estado por FECHA suelta (habilitaciones de la empresa, que no son un tipo de documento). */
export function estadoDoc(f: string | null | undefined): EstadoDoc {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0) return "vencido";
  if (d <= 30) return "por_vencer";
  return "vigente";
}

/**
 * Estado de una FILA de documento, que es distinto: el tipo decide antes que la fecha.
 * Un documento que no caduca nunca sale "sin fecha" — no le falta un dato, es que no lo
 * tiene. Es lo que le impedía al proveedor cerrar su checklist: el portal le pedía subir
 * de nuevo una tarjeta de propiedad perfectamente válida, con una fecha que no existe.
 */
export function estadoDocumento(d: { tipo?: string | null; fecha_vencimiento?: string | null }): EstadoDoc {
  if (docSinVencimiento(d.tipo)) return "sin_vencimiento";
  return estadoDoc(d.fecha_vencimiento);
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
  claveDoc: string;           // "doc:<id>" | "auth_mtc" — dedupe del aviso
  documentoId: number | null;
  vehiculoId: number | null;
  vehiculoPlaca: string | null;
  tipo: string;
  fechaVencimiento: string;
  dias: number;
  estado: "por_vencer" | "vencido";
};

/** Junta, para UNA empresa, los documentos obligatorios (propios + por unidad) y su
 *  autorización de transporte, que estén vencidos o por vencer (≤30 días). */
export async function documentosPorVencerDeEmpresa(admin: any, empresa: {
  id: number; venc_autorizacion?: string | null;
}): Promise<ItemVencimiento[]> {
  const items: ItemVencimiento[] = [];

  // El filtro por tipo se hace en JS con `tipoCanonico()` y NO con un `.in("tipo", …)`: en la
  // base el tipo es texto tecleado, así que un `.in` con las etiquetas de hoy se salta las
  // filas escritas con el nombre viejo ("Habilitación SUTRAN") o sin tildes — que son
  // exactamente las que nadie ha revisado. Un aviso que no se manda no se nota.
  const { data: docs } = await admin
    .from("documentos_tercero")
    .select("id, vehiculo_id, tipo, fecha_vencimiento")
    .eq("empresa_id", empresa.id)
    .not("fecha_vencimiento", "is", null);

  type FilaDoc = { id: number; vehiculo_id: number | null; tipo: string; fecha_vencimiento: string };
  const obligatorios = new Set(TIPOS_DOC_OBLIGATORIOS);
  const relevantes = ((docs || []) as FilaDoc[]).filter((d) => {
    const t = tipoCanonico(d.tipo);
    // La Tarjeta de Propiedad no caduca: pedirle al proveedor que la "renueve" es pedirle
    // un trámite que no existe, y le enseña a ignorar el correo que sí importa. Si trae una
    // fecha tecleada por error, se ignora igual — ver `sinVencimiento`.
    return !!t && !t.sinVencimiento && obligatorios.has(t.canonico);
  });

  const vehIds = [...new Set(relevantes.map((d) => d.vehiculo_id).filter(Boolean))];
  const placaPorVeh: Record<number, string> = {};
  if (vehIds.length) {
    const { data: vehs } = await admin.from("vehiculos_tercero").select("id, placa").in("id", vehIds);
    for (const v of vehs || []) placaPorVeh[v.id] = v.placa;
  }

  for (const d of relevantes) {
    const est = estadoDoc(d.fecha_vencimiento);
    if (est !== "por_vencer" && est !== "vencido") continue;
    items.push({
      claveDoc: `doc:${d.id}`, documentoId: d.id, vehiculoId: d.vehiculo_id,
      vehiculoPlaca: d.vehiculo_id ? placaPorVeh[d.vehiculo_id] ?? null : null,
      // Se le escribe al proveedor con el nombre de HOY aunque su fila guarde el viejo: el
      // correo se lee fuera del ERP, y "Habilitación SUTRAN" ya no es como se llama el papel.
      tipo: etiquetaTipoDoc(d.tipo), fechaVencimiento: d.fecha_vencimiento,
      dias: diasPara(d.fecha_vencimiento)!, estado: est,
    });
  }

  // "Autorización de transporte" y no "Autorización MTC": la firma el MTC, la ATU, un
  // Gobierno Regional o una Municipalidad Provincial según el ámbito, y el correo lo lee el
  // proveedor — pedirle a un operador de la ATU que renueve su "MTC" es pedirle un papel que
  // no tiene. La antigua "Habilitación SUTRAN" ya no se avisa: SUTRAN fiscaliza, no autoriza,
  // así que ese correo le pedía renovar algo que nadie le emite.
  for (const h of [
    { clave: "auth_mtc", tipo: "Autorización de transporte", f: empresa.venc_autorizacion },
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
