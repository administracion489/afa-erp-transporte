// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-correo.ts — El correo interno de una reserva de traslado: «pago REPORTADO,
// pendiente de verificar» (con el comprobante adjunto) y «reserva por confirmar disponibilidad».
// PURO: arma asunto, HTML y texto; quien envía es el servidor.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. EL CORREO NO DICE «PAGADO»: dice que el cliente REPORTÓ un pago y que no se registra el
//     adelanto hasta ver el dinero en la cuenta. Lo que leyó la IA va rotulado «puede equivocarse».
//  2. TODO LO QUE NO ESCRIBIÓ EL CÓDIGO PASA POR `escHtml` (lib/html-escape.ts): el nombre del
//     cliente, el recojo, lo que dice la foto. Sin eso, quien manda la foto escribe el HTML del
//     correo (enlaces falsos con el remitente de la empresa).
//  3. A QUIÉN: la dirección de la configuración (`traslados_config.reserva_correo`) y, si no hay, la
//     del perfil de la empresa; partida con `correosDeTexto` (la MISMA de la copia interna) y con su
//     procedencia declarada, porque cada una se corrige en otro sitio.
// ──────────────────────────────────────────────────────────────────────────────

import { escHtml } from "../html-escape";
import { correosDeTexto } from "../ocupacion/copia-interna";
import { TEXTO_COTEJO, type Cotejo, type LecturaComprobante } from "./comprobante-pago";
import { MOTIVO_ORDEN, frasePlazo, type MotivoOrden } from "./reserva-orden";
import { dinero, fmtPct } from "./reserva-pago";
import { celularImprimible } from "./cotizacion-traslado";
import type { Moneda } from "../cotizacion-moneda";
import { fechaLima, minutoDelDiaLima, minutosAHhmm } from "../alertas-horario";

// ── 1. A quién ───────────────────────────────────────────────────────────────

export type FuenteCorreoReserva = "configurada" | "perfil_empresa";

export const FUENTE_CORREO_RESERVA: Record<FuenteCorreoReserva, string> = {
  configurada: "el correo de reservas de /tarifario → Zonas y traslados → Ajustes",
  perfil_empresa: "el correo del perfil de la empresa (/configuracion/perfil)",
};

/** Los destinatarios, sin repetir, con su procedencia. Sin ninguno, `fuente` null: no se envía. */
export function destinatariosReserva(x: { correoConfig?: string | null; emailEmpresa?: string | null }): { correos: string[]; fuente: FuenteCorreoReserva | null } {
  const cascada: { correos: string[]; fuente: FuenteCorreoReserva }[] = [
    { correos: correosDeTexto(x.correoConfig), fuente: "configurada" },
    { correos: correosDeTexto(x.emailEmpresa), fuente: "perfil_empresa" },
  ];
  const elegido = cascada.find((c) => c.correos.length);
  return elegido ? { correos: [...new Set(elegido.correos)], fuente: elegido.fuente } : { correos: [], fuente: null };
}

// ── 2. El correo ─────────────────────────────────────────────────────────────

export type TipoCorreoReserva = "pago_reportado" | "por_confirmar" | "pago_sin_cotizacion";

export type DatosCorreoReserva = {
  tipo: TipoCorreoReserva;
  cliente: { nombre?: string | null; waId?: string | null };
  cotizacion: { numero?: string | null; origen?: string | null; destino?: string | null; fecha?: string | null; hora?: string | null } | null;
  moneda: Moneda;
  total: number | null;
  adelanto: number | null;
  pct: number | null;
  lectura?: LecturaComprobante | null;
  cotejo?: Cotejo | null;
  confirmarAntesMs?: number | null;
  ahoraMs: number;
  motivos?: readonly MotivoOrden[] | null;
  urgente?: boolean;
  /** El comprobante va adjunto (o no se pudo adjuntar). */
  adjunto?: boolean;
  convId?: string | null;
  /** `NEXT_PUBLIC_APP_URL`. Sin una URL http(s), el correo va sin enlace. */
  appUrl?: string | null;
};

export type CorreoReserva = { asunto: string; html: string; texto: string };

const linea = (v: unknown, max = 120) => Array.from(String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("");
const fechaDdMm = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const hora5 = (h: string | null | undefined) => (/^\d{1,2}:\d{2}/.test(String(h ?? "")) ? String(h).slice(0, 5) : "");
const instante = (ms: number) => `${fechaDdMm(fechaLima(ms))} ${minutosAHhmm(minutoDelDiaLima(ms))}`;

/** El enlace a la conversación, solo con una URL http(s) limpia y un id sin rarezas. */
export function enlaceConversacion(appUrl: string | null | undefined, convId: string | null | undefined): string | null {
  const base = String(appUrl ?? "").trim().replace(/\/+$/, "");
  const id = String(convId ?? "").trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(base) || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
  return `${base}/crm?conv=${encodeURIComponent(id)}`;
}

/** Asunto, HTML (con `escHtml`) y texto plano del correo interno. */
export function correoReserva(d: DatosCorreoReserva): CorreoReserva {
  const c = d.cotizacion;
  const numero = linea(c?.numero, 30) || "—";
  const cliente = linea(d.cliente?.nombre, 60) || "cliente sin nombre";
  const wa = celularImprimible(d.cliente?.waId ?? null) ?? (linea(d.cliente?.waId, 20) || "—");
  const cuando = [fechaDdMm(c?.fecha), hora5(c?.hora)].filter(Boolean).join(" ");
  const ruta = [linea(c?.origen, 120), linea(c?.destino, 120)].filter(Boolean).join(" → ");
  const plazoFrase = frasePlazo(d.confirmarAntesMs ?? null, d.ahoraMs);
  const plazo = plazoFrase && d.confirmarAntesMs != null ? `${plazoFrase} (${instante(d.confirmarAntesMs)})` : "sin plazo calculado: confírmala cuanto antes";
  const noCuadra = d.tipo === "pago_reportado" && d.cotejo != null && !d.cotejo.seguro;

  const asunto = linea(
    d.tipo === "pago_reportado"
      ? `${noCuadra ? "⚠ NO CUADRA · " : ""}Pago REPORTADO (sin verificar) · Cotización N° ${numero} · ${cliente}${cuando ? ` · ${cuando}` : ""}`
      : d.tipo === "por_confirmar"
        ? `${d.urgente ? "⚠ URGENTE · " : ""}Reserva por confirmar disponibilidad · Cotización N° ${numero} · ${cliente}${cuando ? ` · ${cuando}` : ""}`
        : `⚠ Comprobante sin cotización que reservar · ${cliente}`,
    200,
  );

  const aviso = d.tipo === "pago_reportado"
    ? "Pago REPORTADO por el cliente, PENDIENTE de verificar en el banco: no registres el adelanto hasta ver el dinero en la cuenta."
    : d.tipo === "por_confirmar"
      ? "Reserva por confirmar: el cliente aceptó la cotización y todavía NO se le pidió el pago. Confirma si hay una unidad disponible desde la tarjeta del CRM."
      : "El cliente mandó un comprobante de pago y no hay UNA cotización de traslado enviada que reservar (ninguna, o varias): revisa la conversación. No registres ningún adelanto hasta ver el dinero en la cuenta.";

  const filas: [string, string][] = [
    ["Cliente", cliente],
    ["WhatsApp", wa],
  ];
  if (c) {
    filas.push(["Cotización", `N° ${numero}`]);
    if (cuando || ruta) filas.push(["Servicio", [cuando, ruta].filter(Boolean).join(" · ")]);
  }
  if (d.total != null) filas.push(["Total", dinero(d.total, d.moneda)]);
  if (d.adelanto != null) filas.push(["Adelanto esperado", `${dinero(d.adelanto, d.moneda)}${d.pct != null ? ` (${fmtPct(d.pct)} %)` : ""}`]);
  else if (d.tipo !== "pago_sin_cotizacion") filas.push(["Adelanto esperado", "ninguno (crédito o sin porcentaje configurado)"]);
  if (d.tipo !== "pago_sin_cotizacion") filas.push(["Plazo para confirmar", plazo]);

  const leido: [string, string][] = [];
  const l = d.lectura;
  if (l) {
    leido.push(["Es un comprobante", l.es_comprobante ? "sí" : "no"]);
    if (l.texto_monto || l.monto != null) leido.push(["Monto", [linea(l.texto_monto, 40), l.monto != null ? `(${l.monto})` : ""].filter(Boolean).join(" ")]);
    if (l.moneda) leido.push(["Moneda", l.moneda]);
    if (l.fecha || l.hora) leido.push(["Fecha", [fechaDdMm(l.fecha), l.hora ?? ""].filter(Boolean).join(" ")]);
    if (l.numero_operacion) leido.push(["N° de operación", linea(l.numero_operacion, 40)]);
    if (l.medio) leido.push(["Medio", l.medio]);
    if (l.banco_origen) leido.push(["Desde", linea(l.banco_origen, 60)]);
    if (l.banco_destino || l.cuenta_destino || l.titular_destino) {
      leido.push(["Hacia", [linea(l.banco_destino, 60), linea(l.cuenta_destino, 40), linea(l.titular_destino, 80)].filter(Boolean).join(" · ")]);
    }
    if (l.confianza) leido.push(["Confianza de la lectura", l.confianza]);
  }
  const cotejo = (d.cotejo?.codigos ?? []).map((k) => TEXTO_COTEJO[k] ?? k);
  const motivos = (d.motivos ?? []).map((m) => MOTIVO_ORDEN[m] ?? m);
  const enlace = enlaceConversacion(d.appUrl, d.convId);

  // HTML: TODO dato pasa por escHtml (los textos fijos de arriba no llevan & < > " ').
  const tabla = (rows: [string, string][]) =>
    `<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${escHtml(k)}</td><td style="padding:2px 0"><b>${escHtml(v)}</b></td></tr>`).join("")}</table>`;
  const lista = (xs: string[]) => `<ul>${xs.map((x) => `<li>${escHtml(x)}</li>`).join("")}</ul>`;
  const partes: string[] = [
    `<p style="font-size:15px"><b>${escHtml(aviso)}</b></p>`,
    tabla(filas),
  ];
  if (leido.length) {
    partes.push(`<p><b>Lo que leyó la IA en el comprobante (puede equivocarse):</b></p>`, tabla(leido));
  }
  if (d.tipo === "pago_reportado") {
    partes.push(`<p>${escHtml(d.adjunto ? "El comprobante va adjunto a este correo." : "El comprobante no se pudo adjuntar: míralo en la conversación del CRM.")}</p>`);
  }
  if (cotejo.length) partes.push(`<p><b>Cotejo con la cotización:</b></p>`, lista(cotejo));
  if (motivos.length) partes.push(`<p><b>Por qué no se le pidió el pago todavía:</b></p>`, lista(motivos));
  if (enlace) partes.push(`<p><a href="${escHtml(enlace)}">Abrir la conversación en el CRM</a></p>`);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111">${partes.join("\n")}</div>`;

  const texto = [
    aviso,
    "",
    ...filas.map(([k, v]) => `${k}: ${v}`),
    ...(leido.length ? ["", "Lo que leyó la IA en el comprobante (puede equivocarse):", ...leido.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(cotejo.length ? ["", "Cotejo con la cotización:", ...cotejo.map((x) => `- ${x}`)] : []),
    ...(motivos.length ? ["", "Por qué no se le pidió el pago todavía:", ...motivos.map((x) => `- ${x}`)] : []),
    ...(enlace ? ["", `Abrir la conversación en el CRM: ${enlace}`] : []),
  ].join("\n");

  return { asunto, html, texto };
}
