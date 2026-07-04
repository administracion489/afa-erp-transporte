"use client";
// ============================================================
// /dev/elia-config — Banco de pruebas VISUAL de la página de
// configuración de ELIA (solo desarrollo, fetch simulado).
// ============================================================
import { useEffect, useState } from "react";
import { EliaConfigInner } from "@/app/configuracion/elia/page";

const ES_DEV = process.env.NODE_ENV !== "production";

const RESPUESTA_DEMO = {
  ok: true,
  faltaSql: false,
  config: { activa: true, modelo: "claude-sonnet-5", limite_mensual_usd: 300, aviso_pct: 80 },
  uso: {
    mes: "2026-07",
    gasto: 187.4,
    mensajes: 2610,
    por_usuario: [
      { usuario: "Carlos Demo", mensajes: 840, costo: 61.2 },
      { usuario: "María Ops", mensajes: 720, costo: 48.9 },
      { usuario: "Jorge Despacho", mensajes: 560, costo: 39.4 },
      { usuario: "Lucía Finanzas", mensajes: 300, costo: 24.6 },
      { usuario: "Pedro Flota", mensajes: 190, costo: 13.3 },
    ],
    ultimos: [],
  },
  modelos: [
    { id: "claude-opus-4-8", etiqueta: "Claude Opus 4.8", precio_entrada: 5, precio_salida: 25 },
    { id: "claude-sonnet-5", etiqueta: "Claude Sonnet 5", precio_entrada: 3, precio_salida: 15 },
    { id: "claude-haiku-4-5", etiqueta: "Claude Haiku 4.5", precio_entrada: 1, precio_salida: 5 },
  ],
};

export default function DevEliaConfig() {
  const [listo, setListo] = useState(false);

  useEffect(() => {
    if (!ES_DEV) return;
    const original = window.fetch.bind(window);
    window.fetch = async (entrada: any, init?: any) => {
      const url = typeof entrada === "string" ? entrada : entrada?.url ?? "";
      if (url.includes("/api/elia/config")) {
        if (init?.method === "POST")
          return new Response(JSON.stringify({ ok: true, mensaje: "Configuración guardada" }), {
            headers: { "Content-Type": "application/json" },
          });
        return new Response(JSON.stringify(RESPUESTA_DEMO), { headers: { "Content-Type": "application/json" } });
      }
      return original(entrada, init);
    };
    setListo(true);
    return () => {
      window.fetch = original;
    };
  }, []);

  if (!ES_DEV) return null;

  return (
    <div className="min-h-screen bg-[#eef3f8] p-8">
      <p className="text-xs text-[#8693A6] mb-4">Banco de pruebas · datos simulados · solo desarrollo</p>
      {listo && <EliaConfigInner />}
    </div>
  );
}
