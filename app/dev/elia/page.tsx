"use client";
// ============================================================
// /dev/elia — Banco de pruebas VISUAL de ELIA (solo desarrollo).
// Intercepta fetch para simular el radar, el stream SSE y las
// acciones, sin tocar Supabase ni Anthropic. En producción esta
// página no hace nada (y el layout no la expone como pública).
// ============================================================
import { useEffect, useState } from "react";
import EliaPanel from "@/app/_components/elia";
import type { EventoElia } from "@/lib/elia/tipos";

const ES_DEV = process.env.NODE_ENV !== "production";

// ── Guion de demostración ────────────────────────────────────────────────────
const RADAR_DEMO = [
  { nivel: "critico", texto: "1 documento vehicular obligatorio VENCIDO", href: "/documentos-vehiculares" },
  { nivel: "atencion", texto: "2 servicios de hoy sin conductor asignado", href: "/programacion" },
  { nivel: "info", texto: "5 servicios finalizados por liquidar", href: "/facturacion" },
];

const SERVICIOS_DEMO = [
  { id: 341, codigo: "AFA-0341", origen: "San Isidro", destino: "Planta Lurín", fecha: "2026-07-05", hora: "06:30", estado: "confirmada", estadoEtiqueta: "Confirmada", cliente: "Minera Andina SAC", unidad: "C4X-829", conductor: "J. Huamán" },
  { id: 342, codigo: "AFA-0342", origen: "Miraflores", destino: "Aeropuerto Jorge Chávez", fecha: "2026-07-05", hora: "09:15", estado: "programada", estadoEtiqueta: "Programada", cliente: "Turismo Pacífico", unidad: "F7B-114", conductor: null },
  { id: 343, codigo: "AFA-0343", origen: "Surco", destino: "Campamento Chilca", fecha: "2026-07-05", hora: "14:00", estado: "pendiente", estadoEtiqueta: "Pendiente", cliente: "Constructora Delta", unidad: null, conductor: null },
];

function streamDemo(): Response {
  const encoder = new TextEncoder();
  const eventos: (EventoElia | { espera: number })[] = [
    { espera: 500 },
    { t: "tool", d: { nombre: "buscar_servicios", etiqueta: "Buscando servicios…" } },
    { espera: 900 },
    { t: "ui", d: { tipo: "servicios", items: SERVICIOS_DEMO as any } },
    { espera: 250 },
    { t: "texto", d: "Listo, encontré **3 servicios para mañana**. " },
    { espera: 220 },
    { t: "texto", d: "Ojo con dos cosas: el viaje al aeropuerto de **Turismo Pacífico** aún no tiene conductor, " },
    { espera: 220 },
    { t: "texto", d: "y el de **Constructora Delta** sigue pendiente y sin unidad.\n\n¿Quieres que te lleve a Programación para resolverlo?" },
    { espera: 200 },
    { t: "ui", d: { tipo: "link", href: "/programacion", etiqueta: "Ir a Programación" } },
    { espera: 150 },
    {
      t: "ui",
      d: {
        tipo: "accion",
        accion: {
          tipo: "recordatorio_reserva",
          reserva_id: 341,
          titulo: "Enviar recordatorio a los pasajeros",
          detalle: "Servicio #341 (AFA-0341): San Isidro → Planta Lurín · 2026-07-05 06:30",
        },
      },
    },
    { t: "fin", d: null },
  ];

  const stream = new ReadableStream({
    async start(controller) {
      for (const ev of eventos) {
        if ("espera" in ev) {
          await new Promise((r) => setTimeout(r, ev.espera));
          continue;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

export default function DevElia() {
  const [listo, setListo] = useState(false);

  useEffect(() => {
    if (!ES_DEV) return;
    const original = window.fetch.bind(window);
    window.fetch = async (entrada: any, init?: any) => {
      const url = typeof entrada === "string" ? entrada : entrada?.url ?? "";
      if (url.includes("/api/elia/radar"))
        return new Response(JSON.stringify({ ok: true, items: RADAR_DEMO }), { headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/elia/accion"))
        return new Response(JSON.stringify({ ok: true, mensaje: "✅ Listo, envié el recordatorio a los 12 pasajeros del servicio #341." }), { headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/elia")) return streamDemo();
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
      <div className="max-w-lg">
        <h1 className="text-xl font-extrabold text-[#0b315f]">Banco de pruebas · ELIA</h1>
        <p className="text-sm text-[#5B6B82] mt-1">
          Página solo de desarrollo. El radar, el stream y las acciones están simulados — abre el orbe azul
          (abajo a la derecha) y escribe cualquier cosa para ver la conversación de demostración.
        </p>
        <button
          onClick={() => {
            sessionStorage.removeItem("elia_chat_v1");
            sessionStorage.removeItem("elia_radar_v1");
            location.reload();
          }}
          className="mt-3 text-xs font-bold text-[#1262bd] border border-[#2f8ee9]/40 rounded-lg px-3 py-1.5 hover:bg-[#2f8ee9]/10"
        >
          Reiniciar demo
        </button>
      </div>
      {listo && <EliaPanel nombre="Carlos Demo" rol="admin" permisos={[]} />}
    </div>
  );
}
