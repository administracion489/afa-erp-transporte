"use client";
// Inbox Notificaciones: las respuestas que llegan al número de AVISOS automáticos
// (whatsapp_numeros con usa_avisos y sin usa_crm). Misma pantalla que el CRM, otra
// bandeja; aquí el agente IA no responde (lo decide lib/crm-ia.ts).
import { BandejaCRM } from "@/components/crm/BandejaCRM";

export default function InboxNotificacionesPage() {
  return <BandejaCRM bandeja="avisos" />;
}
