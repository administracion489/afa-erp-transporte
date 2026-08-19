"use client";

// components/NotificadorMensajesPasajeros.tsx
// Aviso global de mensajes nuevos de pasajeros: se monta una sola vez en el layout
// raíz (no solo en /seguimiento) para que el operador se entere sin importar en qué
// módulo del ERP esté. Cuatro señales, todas disparadas por el mismo evento:
//   1) Globo (toast) flotante, siempre.
//   2) Sonido corto, siempre (mismo patrón de Web Audio API que la alarma SOS de
//      /monitoreo, con un timbre distinto para no confundirlos).
//   3) Notificación nativa del navegador — solo si la pestaña está en 2º plano.
//   4) Título de la pestaña parpadeando — solo si la pestaña está en 2º plano;
//      se apaga solo al volver el foco.
// Colocar en: components/NotificadorMensajesPasajeros.tsx

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MensajeNuevo } from "@/lib/useMensajesNoLeidos";

function reproducirDing() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    // Dos notas ascendentes en seno — timbre de "chat", distinto del cuadrado grave del SOS.
    [880, 1318].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      const inicio = t + i * 0.12;
      gain.gain.setValueAtTime(0.0001, inicio);
      gain.gain.exponentialRampToValueAtTime(0.22, inicio + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.28);
      osc.start(inicio);
      osc.stop(inicio + 0.3);
    });
  } catch {}
}

type Toast = { key: number; nombre: string; mensaje: string };

export default function NotificadorMensajesPasajeros({
  noLeidos,
  ultimo,
}: {
  noLeidos: number;
  ultimo: MensajeNuevo | null;
}) {
  const router = useRouter();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const tituloOriginalRef = useRef<string | null>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noLeidosRef = useRef(noLeidos);
  const permisoPedidoRef = useRef(false);

  useEffect(() => { noLeidosRef.current = noLeidos; }, [noLeidos]);

  function irAMensajes() {
    router.push("/seguimiento?mensajes=1");
  }

  function detenerParpadeo() {
    if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; }
    if (tituloOriginalRef.current !== null) document.title = tituloOriginalRef.current;
  }

  // Pide permiso de notificaciones una sola vez (solo si el rol ve Seguimiento).
  useEffect(() => {
    if (permisoPedidoRef.current) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "default") return;
    permisoPedidoRef.current = true;
    Notification.requestPermission().catch(() => {});
  }, []);

  // Deja de parpadear el título en cuanto el operador vuelve a la pestaña.
  useEffect(() => {
    function onVisibility() { if (!document.hidden) detenerParpadeo(); }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      detenerParpadeo();
      Object.values(timersRef.current).forEach(clearTimeout);
    };
  }, []);

  // Reacciona a cada mensaje nuevo del pasajero.
  useEffect(() => {
    if (!ultimo) return;
    reproducirDing();

    const key = ultimo.id;
    setToasts(prev => [...prev, { key, nombre: ultimo.pasajeroNombre, mensaje: ultimo.mensaje }].slice(-4));
    timersRef.current[key] = setTimeout(() => {
      setToasts(prev => prev.filter(x => x.key !== key));
      delete timersRef.current[key];
    }, 7000);

    if (document.hidden) {
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          const n = new Notification(`💬 ${ultimo.pasajeroNombre}`, {
            body: ultimo.mensaje,
            tag: "afa-chat-operador",
            icon: "/logoafa.png",
          });
          n.onclick = () => { window.focus(); irAMensajes(); n.close(); };
        } catch {}
      }

      if (tituloOriginalRef.current === null) tituloOriginalRef.current = document.title;
      if (blinkTimerRef.current) clearInterval(blinkTimerRef.current);
      let encendido = false;
      blinkTimerRef.current = setInterval(() => {
        const n = noLeidosRef.current;
        document.title = encendido
          ? tituloOriginalRef.current!
          : `🔴 ${n > 1 ? `${n} mensajes nuevos` : "Mensaje nuevo"} — ${tituloOriginalRef.current}`;
        encendido = !encendido;
      }, 1000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimo]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-[100] flex flex-col gap-2"
      style={{ bottom: 20, right: 20, width: 340, maxWidth: "calc(100vw - 40px)" }}
    >
      {toasts.map(t => (
        <button
          key={t.key}
          onClick={() => {
            setToasts(prev => prev.filter(x => x.key !== t.key));
            irAMensajes();
          }}
          className="flex items-start gap-3 text-left rounded-2xl shadow-2xl px-4 py-3 animate-[afaToastIn_.25s_ease-out]"
          style={{ background: "#0b315f", border: "1px solid rgba(255,255,255,0.1)" }}
        >
          <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center text-white text-sm font-black flex-shrink-0">
            {t.nombre.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-white text-sm font-bold truncate">💬 {t.nombre}</p>
            <p className="text-blue-100/90 text-xs mt-0.5 line-clamp-2">{t.mensaje}</p>
          </div>
          <span
            role="button"
            aria-label="Cerrar"
            onClick={e => {
              e.stopPropagation();
              setToasts(prev => prev.filter(x => x.key !== t.key));
            }}
            className="text-white/40 hover:text-white text-xs flex-shrink-0 mt-0.5"
          >
            ✕
          </span>
        </button>
      ))}
      <style jsx>{`
        @keyframes afaToastIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
