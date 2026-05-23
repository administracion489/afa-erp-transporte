"use client";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";

const SECCION_STYLE: React.CSSProperties = {
  background: "white",
  borderRadius: 20,
  border: "1px solid #e5e7eb",
  padding: "24px 28px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const TAG_STYLE: React.CSSProperties = {
  display: "inline-block",
  fontSize: 10,
  fontWeight: 700,
  padding: "3px 10px",
  borderRadius: 999,
  letterSpacing: "0.05em",
};

export default function SistemaPage() {
  const [version, setVersion] = useState<string>("—");
  const [urlSupabase, setUrlSupabase] = useState<string>("—");

  useEffect(() => {
    setUrlSupabase(
      process.env.NEXT_PUBLIC_SUPABASE_URL
        ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
        : "No configurado"
    );
    fetch("/api/notificaciones/recordatorio", { method: "HEAD" })
      .then(() => setVersion("OK"))
      .catch(() => setVersion("—"));
  }, []);

  const PARAMS = [
    {
      grupo: "Autenticación",
      items: [
        {
          clave: "Proveedor",
          valor: "Supabase Auth",
          estado: "activo",
          desc: "Sesiones gestionadas por Supabase",
        },
        {
          clave: "Middleware",
          valor: "Edge (cookie sb-*)",
          estado: "activo",
          desc: "Verificación de sesión en el borde",
        },
        {
          clave: "App conductor",
          valor: "PIN local (localStorage)",
          estado: "activo",
          desc: "Sesión independiente para /conductor",
        },
      ],
    },
    {
      grupo: "Notificaciones",
      items: [
        {
          clave: "Email",
          valor: "Resend API",
          estado: "activo",
          desc: "RESEND_API_KEY debe estar configurada",
        },
        {
          clave: "WhatsApp",
          valor: "Twilio",
          estado: "activo",
          desc: "TWILIO_WHATSAPP_FROM = whatsapp:+51…",
        },
        {
          clave: "SMS (fallback)",
          valor: "Twilio SMS",
          estado: "activo",
          desc: "Aplica cuando no hay email ni WhatsApp",
        },
        {
          clave: "Cron recordatorio",
          valor: "0 13 * * * UTC (08:00 Lima)",
          estado: "activo",
          desc: "Vercel cron — protegido por CRON_SECRET",
        },
      ],
    },
    {
      grupo: "Mapas y Rutas",
      items: [
        {
          clave: "Renderizado",
          valor: "Mapbox GL",
          estado: "activo",
          desc: "NEXT_PUBLIC_MAPBOX_TOKEN requerido",
        },
        {
          clave: "Routing",
          valor: "Google Directions API",
          estado: "activo",
          desc: "GOOGLE_MAPS_API_KEY — proxy en /api/ruta",
        },
      ],
    },
    {
      grupo: "Base de datos",
      items: [
        {
          clave: "Proveedor",
          valor: "Supabase Postgres",
          estado: "activo",
          desc: urlSupabase,
        },
        {
          clave: "ORM",
          valor: "Directo via @supabase/supabase-js",
          estado: "activo",
          desc: "Prisma instalado pero no activo",
        },
        {
          clave: "Service Role",
          valor: "SUPABASE_SERVICE_ROLE_KEY",
          estado: "activo",
          desc: "Solo en server-side — nunca en cliente",
        },
      ],
    },
  ];

  const ENV_VARS = [
    { nombre: "NEXT_PUBLIC_SUPABASE_URL", uso: "URL del proyecto Supabase", requerida: true },
    { nombre: "NEXT_PUBLIC_SUPABASE_ANON_KEY", uso: "Clave anónima Supabase", requerida: true },
    { nombre: "SUPABASE_SERVICE_ROLE_KEY", uso: "Clave admin (server-side)", requerida: true },
    { nombre: "NEXT_PUBLIC_MAPBOX_TOKEN", uso: "Renderizado de mapas", requerida: true },
    { nombre: "GOOGLE_MAPS_API_KEY", uso: "Proxy de rutas Google Directions", requerida: true },
    { nombre: "RESEND_API_KEY", uso: "Envío de emails", requerida: false },
    { nombre: "RESEND_FROM", uso: "Dirección remitente emails", requerida: false },
    { nombre: "TWILIO_ACCOUNT_SID", uso: "WhatsApp y SMS", requerida: false },
    { nombre: "TWILIO_AUTH_TOKEN", uso: "WhatsApp y SMS", requerida: false },
    { nombre: "TWILIO_WHATSAPP_FROM", uso: "Número WhatsApp remitente", requerida: false },
    { nombre: "TWILIO_SMS_FROM", uso: "Número SMS remitente", requerida: false },
    { nombre: "EMPRESA_NOMBRE", uso: "Nombre en notificaciones", requerida: false },
    { nombre: "CRON_SECRET", uso: "Protege el endpoint del cron", requerida: false },
  ];

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto" }}>
      {/* Cabecera */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: "#111827", margin: 0 }}>
          Parámetros del Sistema
        </h1>
        <p style={{ fontSize: 13, color: "#9ca3af", marginTop: 6, margin: "6px 0 0" }}>
          Configuración técnica del ERP — Solo lectura · Modificar en variables de entorno y código
        </p>
      </div>

      {/* Servicios */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20, marginBottom: 24 }}>
        {PARAMS.map((s) => (
          <div key={s.grupo} style={SECCION_STYLE}>
            <h2
              style={{
                fontSize: 12,
                fontWeight: 800,
                color: "#0b315f",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              {s.grupo}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {s.items.map((item, i) => (
                <div
                  key={item.clave}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "12px 0",
                    borderTop: i > 0 ? "1px solid #f3f4f6" : "none",
                    gap: 16,
                  }}
                >
                  <div style={{ flex: "0 0 200px" }}>
                    <p
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#374151",
                        margin: 0,
                      }}
                    >
                      {item.clave}
                    </p>
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 12, fontFamily: "monospace", color: "#0b315f", fontWeight: 700, margin: "0 0 2px" }}>
                      {item.valor}
                    </p>
                    <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>{item.desc}</p>
                  </div>
                  <span
                    style={{
                      ...TAG_STYLE,
                      background: "#dcfce7",
                      color: "#15803d",
                      flexShrink: 0,
                    }}
                  >
                    ACTIVO
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Variables de entorno */}
      <div style={SECCION_STYLE}>
        <h2
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: "#0b315f",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          Variables de Entorno
        </h2>
        <div
          style={{
            background: "#f8fafc",
            borderRadius: 14,
            border: "1px solid #e2e8f0",
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f1f5f9" }}>
                {["Variable", "Uso", "Req."].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "10px 16px",
                      textAlign: "left",
                      fontSize: 10,
                      fontWeight: 800,
                      color: "#6b7280",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ENV_VARS.map((v, i) => (
                <tr
                  key={v.nombre}
                  style={{
                    borderTop: i > 0 ? "1px solid #f0f4f8" : "none",
                  }}
                >
                  <td style={{ padding: "10px 16px" }}>
                    <code
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "#0b315f",
                        fontWeight: 700,
                        background: "#eef3f8",
                        padding: "2px 6px",
                        borderRadius: 6,
                      }}
                    >
                      {v.nombre}
                    </code>
                  </td>
                  <td style={{ padding: "10px 16px", fontSize: 12, color: "#6b7280" }}>
                    {v.uso}
                  </td>
                  <td style={{ padding: "10px 16px" }}>
                    <span
                      style={{
                        ...TAG_STYLE,
                        background: v.requerida ? "#fee2e2" : "#f3f4f6",
                        color: v.requerida ? "#dc2626" : "#9ca3af",
                      }}
                    >
                      {v.requerida ? "REQ" : "OPC"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 12, marginBottom: 0 }}>
          Configurar en <code style={{ fontSize: 10, fontFamily: "monospace", background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>.env.local</code> (desarrollo) o en el dashboard de Vercel → Settings → Environment Variables (producción).
        </p>
      </div>

      <div style={{ paddingBottom: 32 }} />
    </main>
  );
}
