"use client";
// ============================================================
// ELIA — Panel de la asistente de operaciones.
// Botón flotante + panel deslizante con chat en streaming,
// tarjetas de datos reales, radar proactivo y acciones con
// confirmación. Se monta desde app/layout.tsx (solo usuarios ERP).
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { configEstado } from "@/lib/estados";
import type {
  AccionPropuesta,
  BloqueUI,
  EventoElia,
  MensajeHistorial,
  RadarItem,
} from "@/lib/elia/tipos";

type MsgUI = {
  rol: "usuario" | "elia";
  texto: string;
  bloques?: BloqueUI[];
  radar?: RadarItem[];
};

const SK_CHAT = "elia_chat_v1";
const SK_RADAR = "elia_radar_v1";
const RADAR_TTL_MS = 5 * 60 * 1000;

// ── Utilidades ───────────────────────────────────────────────────────────────

async function tokenSesion(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

function saludoHora(): string {
  const h = new Date().getHours();
  if (h < 12) return "Buenos días";
  if (h < 19) return "Buenas tardes";
  return "Buenas noches";
}

/** Render mínimo de markdown: **negritas**, viñetas "- " y saltos de línea. */
function Md({ t }: { t: string }) {
  const lineas = t.split("\n");
  return (
    <>
      {lineas.map((linea, i) => {
        const esViñeta = linea.trimStart().startsWith("- ");
        const contenido = esViñeta ? linea.trimStart().slice(2) : linea;
        const partes = contenido.split(/\*\*(.+?)\*\*/g);
        const nodos = partes.map((p, j) =>
          j % 2 === 1 ? (
            <strong key={j} className="font-bold text-[#0b315f]">
              {p}
            </strong>
          ) : (
            <span key={j}>{p}</span>
          )
        );
        return esViñeta ? (
          <div key={i} className="flex gap-1.5 pl-1">
            <span className="text-[#2f8ee9] flex-shrink-0">•</span>
            <span>{nodos}</span>
          </div>
        ) : (
          <div key={i} className={linea === "" ? "h-2" : ""}>
            {nodos}
          </div>
        );
      })}
    </>
  );
}

// ── Avatar (orbe con gradiente que "respira") ────────────────────────────────

function OrbeElia({ size = 38, activa = false }: { size?: number; activa?: boolean }) {
  return (
    <div
      className="relative rounded-full flex-shrink-0"
      style={{
        width: size,
        height: size,
        background:
          "radial-gradient(circle at 30% 25%, #7db9f2 0%, #2f8ee9 38%, #1262bd 72%, #0b315f 100%)",
        boxShadow: "0 2px 10px rgba(18,98,189,0.45), inset 0 -3px 8px rgba(4,15,30,0.35)",
        animation: activa ? "eliaOrb 1.6s ease-in-out infinite" : "eliaOrb 5s ease-in-out infinite",
      }}
    >
      <div
        className="absolute rounded-full"
        style={{
          top: "16%",
          left: "20%",
          width: "34%",
          height: "24%",
          background: "linear-gradient(180deg, rgba(255,255,255,0.85), rgba(255,255,255,0))",
          filter: "blur(1px)",
          borderRadius: "50%",
        }}
      />
    </div>
  );
}

// ── Bloques enriquecidos ─────────────────────────────────────────────────────

function PillEstado({ estado, etiqueta }: { estado: string; etiqueta: string }) {
  const c = configEstado(estado as any);
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0"
      style={{ background: c.bg, color: c.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
      {etiqueta}
    </span>
  );
}

function TarjetaBloque({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 bg-white border border-[#E4E7ED] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(11,49,95,0.05)]">
      {children}
    </div>
  );
}

const COLOR_SEMAFORO = { verde: "#27AE60", ambar: "#f59e0b", rojo: "#EB5757" } as const;
const COLOR_INTENT = { ok: "#27AE60", warn: "#B07A0F", danger: "#EB5757", info: "#1262bd" } as const;

function Bloque({
  b,
  onNavegar,
  onConfirmar,
  accionEstado,
}: {
  b: BloqueUI;
  onNavegar: (href: string) => void;
  onConfirmar: (a: AccionPropuesta) => void;
  accionEstado: (a: AccionPropuesta) => "pendiente" | "enviando" | "hecha";
}) {
  if (b.tipo === "servicios")
    return (
      <TarjetaBloque>
        {b.items.map((s, i) => (
          <div key={s.id} className={`px-3 py-2.5 ${i > 0 ? "border-t border-[#EEF1F4]" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-bold text-[#0c2d52] truncate">
                {s.origen ?? "—"} <span className="text-[#8693A6] font-medium">→</span> {s.destino ?? "—"}
              </p>
              <PillEstado estado={s.estado} etiqueta={s.estadoEtiqueta} />
            </div>
            <p className="text-[10.5px] text-[#5B6B82] mt-0.5 truncate">
              #{s.id}
              {s.fecha ? ` · ${s.fecha}` : ""}
              {s.hora ? ` ${String(s.hora).slice(0, 5)}` : ""}
              {s.cliente ? ` · ${s.cliente}` : ""}
              {s.unidad ? ` · ${s.unidad}` : ""}
              {s.conductor ? ` · ${s.conductor}` : ""}
            </p>
          </div>
        ))}
      </TarjetaBloque>
    );

  if (b.tipo === "vehiculos")
    return (
      <TarjetaBloque>
        {b.items.map((v, i) => (
          <div key={v.placa + i} className={`px-3 py-2.5 ${i > 0 ? "border-t border-[#EEF1F4]" : ""}`}>
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: COLOR_SEMAFORO[v.semaforo] }}
              />
              <p className="text-[12px] font-bold text-[#0c2d52]" style={{ fontFamily: "var(--font-mono)" }}>
                {v.placa}
              </p>
              <p className="text-[10.5px] text-[#5B6B82] truncate">
                {[v.categoria, v.marcaModelo, v.estado].filter(Boolean).join(" · ")}
              </p>
            </div>
            {v.alertas.length > 0 && (
              <div className="mt-1 pl-4.5 space-y-0.5" style={{ paddingLeft: 18 }}>
                {v.alertas.slice(0, 3).map((a, j) => (
                  <p key={j} className="text-[10.5px] font-semibold" style={{ color: a.includes("VENCIDO") ? "#EB5757" : "#B07A0F" }}>
                    {a}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </TarjetaBloque>
    );

  if (b.tipo === "conductores")
    return (
      <TarjetaBloque>
        {b.items.map((c, i) => (
          <div key={c.nombre + i} className={`px-3 py-2.5 ${i > 0 ? "border-t border-[#EEF1F4]" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-bold text-[#0c2d52] truncate">{c.nombre}</p>
              <span className="text-[10px] text-[#8693A6] flex-shrink-0">{c.estado ?? ""}</span>
            </div>
            {c.alertas.length > 0 && (
              <div className="mt-0.5 space-y-0.5">
                {c.alertas.slice(0, 3).map((a, j) => (
                  <p key={j} className="text-[10.5px] font-semibold" style={{ color: a.includes("VENCIDO") ? "#EB5757" : "#B07A0F" }}>
                    {a}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </TarjetaBloque>
    );

  if (b.tipo === "kpis")
    return (
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {b.items.map((k, i) => (
          <div key={i} className="bg-white border border-[#E4E7ED] rounded-xl px-3 py-2">
            <p className="text-[9px] font-black uppercase tracking-wider text-[#8693A6]">{k.label}</p>
            <p
              className="text-[15px] font-bold mt-0.5"
              style={{ fontFamily: "var(--font-mono)", color: k.intent ? COLOR_INTENT[k.intent] : "#0c2d52" }}
            >
              {k.valor}
            </p>
            {k.sub && <p className="text-[9.5px] text-[#8693A6]">{k.sub}</p>}
          </div>
        ))}
      </div>
    );

  if (b.tipo === "ranking") {
    const colorPuesto = (p: number) =>
      p === 1 ? "#d4a017" : p === 2 ? "#8693A6" : p === 3 ? "#b0764a" : "#c9d2de";
    return (
      <TarjetaBloque>
        <div className="px-3 pt-2.5 pb-1">
          <p className="text-[9px] font-black uppercase tracking-wider text-[#8693A6]">{b.titulo}</p>
        </div>
        {b.items.map((r, i) => (
          <div key={i} className={`px-3 py-2 flex items-center gap-2.5 ${i > 0 ? "border-t border-[#EEF1F4]" : ""}`}>
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white flex-shrink-0"
              style={{ background: colorPuesto(r.puesto) }}
            >
              {r.puesto}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-bold text-[#0c2d52] truncate">{r.nombre}</p>
              {r.sub && <p className="text-[10px] text-[#8693A6] truncate">{r.sub}</p>}
            </div>
            <p className="text-[12px] font-bold text-[#0b315f] flex-shrink-0" style={{ fontFamily: "var(--font-mono)" }}>
              {r.valor}
            </p>
          </div>
        ))}
      </TarjetaBloque>
    );
  }

  if (b.tipo === "serie") {
    const max = Math.max(...b.items.map((s) => s.valor), 1);
    return (
      <TarjetaBloque>
        <div className="px-3 pt-2.5 pb-1">
          <p className="text-[9px] font-black uppercase tracking-wider text-[#8693A6]">{b.titulo}</p>
        </div>
        <div className="px-3 pb-2.5 space-y-1.5">
          {b.items.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-8 text-[10px] font-bold text-[#5B6B82] flex-shrink-0 capitalize">{s.label}</span>
              <div className="flex-1 h-3.5 bg-[#EEF1F4] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(3, Math.round((s.valor / max) * 100))}%`,
                    background: "linear-gradient(90deg, #2f8ee9, #1262bd)",
                  }}
                />
              </div>
              <span className="w-[74px] text-right text-[10.5px] font-bold text-[#0b315f] flex-shrink-0" style={{ fontFamily: "var(--font-mono)" }}>
                {s.etiqueta}
              </span>
            </div>
          ))}
        </div>
      </TarjetaBloque>
    );
  }

  if (b.tipo === "link")
    return (
      <button
        onClick={() => onNavegar(b.href)}
        className="mt-2 inline-flex items-center gap-1.5 bg-white border border-[#2f8ee9]/40 text-[#1262bd] hover:bg-[#2f8ee9]/10 text-[11px] font-bold px-3 py-1.5 rounded-full transition-colors"
      >
        {b.etiqueta}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
    );

  if (b.tipo === "accion") {
    const estado = accionEstado(b.accion);
    return (
      <div className="mt-2 bg-[#E8F1FB] border border-[#2f8ee9]/30 rounded-xl px-3 py-2.5">
        <p className="text-[11.5px] font-bold text-[#0b315f]">{b.accion.titulo}</p>
        <p className="text-[10.5px] text-[#1f3a5f] mt-0.5">{b.accion.detalle}</p>
        <div className="flex gap-2 mt-2">
          {estado === "hecha" ? (
            <span className="text-[10.5px] font-bold text-[#27AE60]">✓ Acción realizada</span>
          ) : (
            <button
              onClick={() => onConfirmar(b.accion)}
              disabled={estado === "enviando"}
              className="bg-[#0b315f] hover:bg-[#1262bd] disabled:opacity-50 text-white text-[10.5px] font-bold px-3 py-1.5 rounded-lg transition-colors"
            >
              {estado === "enviando" ? "Ejecutando…" : "Confirmar"}
            </button>
          )}
        </div>
        <p className="text-[9px] text-[#5B6B82] mt-1.5">ELIA nunca ejecuta acciones sin tu confirmación.</p>
      </div>
    );
  }

  return null;
}

function RadarLista({ items, onNavegar }: { items: RadarItem[]; onNavegar: (h: string) => void }) {
  const color = { critico: "#EB5757", atencion: "#B07A0F", info: "#1262bd" } as const;
  return (
    <TarjetaBloque>
      {items.map((r, i) => (
        <div key={i} className={`px-3 py-2 flex items-center gap-2 ${i > 0 ? "border-t border-[#EEF1F4]" : ""}`}>
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color[r.nivel] }} />
          <p className="text-[11px] text-[#1f3a5f] flex-1">{r.texto}</p>
          {r.href && (
            <button
              onClick={() => onNavegar(r.href!)}
              className="text-[10px] font-bold text-[#1262bd] hover:underline flex-shrink-0"
            >
              Ver
            </button>
          )}
        </div>
      ))}
    </TarjetaBloque>
  );
}

// ── Panel principal ──────────────────────────────────────────────────────────

export default function EliaPanel({
  nombre,
  rol,
  permisos,
}: {
  nombre: string;
  rol: string;
  permisos: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [abierto, setAbierto] = useState(false);
  const [mensajes, setMensajes] = useState<MsgUI[]>([]);
  const [input, setInput] = useState("");
  const [escribiendo, setEscribiendo] = useState(false);
  const [estadoTool, setEstadoTool] = useState<string | null>(null);
  const [radar, setRadar] = useState<RadarItem[] | null>(null);
  const [accionesHechas, setAccionesHechas] = useState<Record<string, "enviando" | "hecha">>({});

  const finRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const primerNombre = (nombre || "").trim().split(/\s+/)[0] || "hola";

  // Restaurar conversación (sobrevive a la navegación: el layout remonta en cada ruta)
  useEffect(() => {
    try {
      const crudo = sessionStorage.getItem(SK_CHAT);
      if (crudo) {
        const g = JSON.parse(crudo);
        if (Array.isArray(g.mensajes)) setMensajes(g.mensajes);
        if (g.abierto) setAbierto(true);
        if (g.accionesHechas) setAccionesHechas(g.accionesHechas);
      }
    } catch {}
  }, []);

  // Persistir
  useEffect(() => {
    try {
      sessionStorage.setItem(SK_CHAT, JSON.stringify({ mensajes: mensajes.slice(-40), abierto, accionesHechas }));
    } catch {}
  }, [mensajes, abierto, accionesHechas]);

  // Radar proactivo (cache 5 min en sessionStorage)
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const cache = sessionStorage.getItem(SK_RADAR);
        if (cache) {
          const g = JSON.parse(cache);
          if (Date.now() - g.t < RADAR_TTL_MS) {
            if (vivo) setRadar(g.items);
            return;
          }
        }
        const token = await tokenSesion();
        const res = await fetch("/api/elia/radar", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const json = await res.json();
        if (vivo && Array.isArray(json.items)) {
          setRadar(json.items);
          sessionStorage.setItem(SK_RADAR, JSON.stringify({ t: Date.now(), items: json.items }));
        }
      } catch {}
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // Autoscroll
  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes, estadoTool, abierto]);

  // Cerrar con Esc
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  const mensajeBienvenida = useCallback(
    (avisos: RadarItem[] | null): MsgUI => {
      const texto =
        `${saludoHora()}, ${primerNombre} 👋 Soy **ELIA**, tu asistente de operaciones.\n` +
        `Puedo revisar servicios, flota, conductores, cobranzas o el mapa en vivo — y también llevarte a cualquier pantalla del ERP.` +
        (avisos && avisos.length > 0
          ? `\n\nAntes de empezar: tengo **${avisos.length} aviso${avisos.length > 1 ? "s" : ""}** en el radar de hoy.`
          : avisos
          ? `\n\nPor ahora no veo avisos urgentes en el radar. ¿En qué te ayudo?`
          : `\n\n¿En qué te ayudo?`);
      return { rol: "elia", texto, radar: avisos?.length ? avisos : undefined };
    },
    [primerNombre]
  );

  const abrir = useCallback(() => {
    setAbierto(true);
    setMensajes((prev) => (prev.length > 0 ? prev : [mensajeBienvenida(radar)]));
    setTimeout(() => inputRef.current?.focus(), 250);
  }, [radar, mensajeBienvenida]);

  // Si el radar llega después de abrir y aún no hay conversación, refrescar la bienvenida
  useEffect(() => {
    if (!radar) return;
    setMensajes((prev) =>
      prev.length === 1 && prev[0].rol === "elia" && !prev[0].radar ? [mensajeBienvenida(radar)] : prev
    );
  }, [radar, mensajeBienvenida]);

  const navegar = useCallback(
    (href: string) => {
      setAbierto(false);
      router.push(href);
    },
    [router]
  );

  // ── Enviar mensaje (streaming SSE) ────────────────────────────────────────
  const enviar = useCallback(
    async (textoCrudo?: string) => {
      const texto = (textoCrudo ?? input).trim();
      if (!texto || escribiendo) return;
      setInput("");
      setEscribiendo(true);
      setEstadoTool(null);

      const historialPrevio: MensajeHistorial[] = [...mensajes, { rol: "usuario" as const, texto }]
        .filter((m) => m.texto.trim())
        .map((m) => ({ rol: m.rol, texto: m.texto }));

      setMensajes((prev) => [...prev, { rol: "usuario", texto }, { rol: "elia", texto: "" }]);

      const actualizarUltimo = (fn: (m: MsgUI) => MsgUI) =>
        setMensajes((prev) => {
          const copia = [...prev];
          copia[copia.length - 1] = fn(copia[copia.length - 1]);
          return copia;
        });

      try {
        const token = await tokenSesion();
        const res = await fetch("/api/elia", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ mensajes: historialPrevio, pagina: pathname }),
        });

        if (!res.ok || !res.body) {
          let detalle = "No pude conectarme con el servidor.";
          try {
            detalle = (await res.json()).error ?? detalle;
          } catch {}
          actualizarUltimo((m) => ({ ...m, texto: `Uy, ${detalle} ¿Intentamos de nuevo en un momento?` }));
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const partes = buf.split("\n\n");
          buf = partes.pop() ?? "";
          for (const parte of partes) {
            const linea = parte.trim();
            if (!linea.startsWith("data:")) continue;
            let ev: EventoElia;
            try {
              ev = JSON.parse(linea.slice(5));
            } catch {
              continue;
            }
            if (ev.t === "texto") {
              setEstadoTool(null);
              actualizarUltimo((m) => ({ ...m, texto: m.texto + ev.d }));
            } else if (ev.t === "tool") {
              setEstadoTool(ev.d.etiqueta);
            } else if (ev.t === "ui") {
              actualizarUltimo((m) => ({ ...m, bloques: [...(m.bloques ?? []), ev.d] }));
            } else if (ev.t === "error") {
              actualizarUltimo((m) => ({ ...m, texto: m.texto || ev.d }));
            }
          }
        }
      } catch {
        actualizarUltimo((m) => ({
          ...m,
          texto: m.texto || "Perdí la conexión a mitad de camino. ¿Me repites la consulta?",
        }));
      } finally {
        setEscribiendo(false);
        setEstadoTool(null);
      }
    },
    [input, escribiendo, mensajes, pathname]
  );

  // ── Confirmar acción propuesta ────────────────────────────────────────────
  const claveAccion = (a: AccionPropuesta) => `${a.tipo}-${a.reserva_id}`;
  const accionEstado = (a: AccionPropuesta): "pendiente" | "enviando" | "hecha" =>
    accionesHechas[claveAccion(a)] ?? "pendiente";

  const confirmarAccion = useCallback(async (a: AccionPropuesta) => {
    const clave = claveAccion(a);
    setAccionesHechas((prev) => ({ ...prev, [clave]: "enviando" }));
    try {
      const token = await tokenSesion();
      const res = await fetch("/api/elia/accion", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ accion: a }),
      });
      const json = await res.json().catch(() => ({}));
      const mensaje =
        json.mensaje ?? json.error ?? "No pude completar la acción, inténtalo desde el módulo correspondiente.";
      setAccionesHechas((prev) => ({ ...prev, [clave]: json.ok ? "hecha" : ("pendiente" as any) }));
      setMensajes((prev) => [...prev, { rol: "elia", texto: mensaje }]);
    } catch {
      setAccionesHechas((prev) => {
        const copia = { ...prev };
        delete copia[clave];
        return copia;
      });
      setMensajes((prev) => [...prev, { rol: "elia", texto: "No pude ejecutar la acción por un problema de conexión. ¿Probamos de nuevo?" }]);
    }
  }, []);

  // ── Sugerencias según permisos ────────────────────────────────────────────
  const esAdmin = rol === "admin";
  const tiene = (m: string) => esAdmin || permisos.includes(m);
  const chips: string[] = [];
  if (tiene("dashboard")) chips.push("¿Cómo vamos hoy?");
  if (tiene("reportes")) chips.push("¿Cómo viene el mes vs. el anterior?");
  if (tiene("programacion") || tiene("seguimiento")) chips.push("Servicios de mañana");
  if (tiene("vehiculos")) chips.push("¿Documentos por vencer?");
  if (tiene("monitoreo")) chips.push("¿Qué unidades están transmitiendo?");
  if (tiene("facturacion")) chips.push("¿Cuánto tenemos por cobrar?");
  if (tiene("cotizaciones")) chips.push("¿Cómo va la conversión de cotizaciones?");
  if (tiene("proveedores")) chips.push("¿Alguna tercerizada en riesgo?");
  const chipsVisibles = chips.slice(0, 4);

  const nivelAlerta = radar?.some((r) => r.nivel === "critico")
    ? "critico"
    : radar?.some((r) => r.nivel === "atencion")
    ? "atencion"
    : null;

  const mostrarChips = mensajes.length <= 1 && !escribiendo;

  return (
    <>
      {/* ── Botón flotante ── */}
      {!abierto && (
        <button
          onClick={abrir}
          title="ELIA — tu asistente de operaciones"
          className="fixed bottom-5 right-5 z-40 group"
          style={{ animation: "eliaIn 0.35s ease-out" }}
        >
          <div className="relative">
            <OrbeElia size={54} />
            {nivelAlerta && (
              <span
                className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white"
                style={{
                  background: nivelAlerta === "critico" ? "#EB5757" : "#f59e0b",
                  animation: "eliaPing 1.8s ease-out infinite",
                }}
              />
            )}
            <span
              className="pointer-events-none absolute right-full mr-3 top-1/2 -translate-y-1/2 whitespace-nowrap
                         bg-[#0b2545] text-white text-[11px] font-semibold px-2.5 py-1.5 rounded-lg shadow-xl
                         opacity-0 group-hover:opacity-100 transition-opacity"
            >
              Hola, soy ELIA 👋
            </span>
          </div>
        </button>
      )}

      {/* ── Panel ── */}
      {abierto && (
        <div
          className="fixed inset-y-0 right-0 z-50 w-full sm:w-[420px] flex flex-col bg-[#f6f9fc] shadow-2xl border-l border-[#E4E7ED]"
          style={{ animation: "eliaSlide 0.28s cubic-bezier(0.16,1,0.3,1)" }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-[#0c2d52] to-[#0b315f] flex-shrink-0">
            <OrbeElia size={38} activa={escribiendo} />
            <div className="flex-1 min-w-0">
              <p className="text-white font-extrabold text-[15px] leading-tight tracking-tight">ELIA</p>
              <p className="text-[10.5px] leading-tight mt-0.5 flex items-center gap-1.5">
                {escribiendo ? (
                  <span className="text-[#9db4d4]">{estadoTool ?? "Pensando…"}</span>
                ) : (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" style={{ animation: "eliaPing 2.5s ease-out infinite" }} />
                    <span className="text-[#9db4d4]">Asistente de operaciones · En línea</span>
                  </>
                )}
              </p>
            </div>
            <button
              onClick={() => setAbierto(false)}
              title="Cerrar (Esc)"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Mensajes */}
          <div className="flex-1 overflow-y-auto px-3.5 py-4 space-y-3">
            {mensajes.map((m, i) => (
              <div key={i} style={{ animation: "eliaMsg 0.25s ease-out" }}>
                {m.rol === "usuario" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] bg-[#0b315f] text-white text-[12.5px] leading-relaxed px-3.5 py-2.5 rounded-2xl rounded-br-md whitespace-pre-wrap">
                      {m.texto}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 items-start">
                    <div className="mt-1">
                      <OrbeElia size={24} />
                    </div>
                    <div className="max-w-[88%] min-w-0 flex-1">
                      {(m.texto || (!escribiendo && !m.bloques)) && (
                        <div className="bg-white border border-[#E4E7ED] text-[#1f3a5f] text-[12.5px] leading-relaxed px-3.5 py-2.5 rounded-2xl rounded-bl-md shadow-[0_1px_2px_rgba(11,49,95,0.04)]">
                          <Md t={m.texto} />
                          {i === mensajes.length - 1 && escribiendo && (
                            <span className="inline-block w-1 h-3.5 ml-0.5 bg-[#2f8ee9] align-middle" style={{ animation: "eliaPing 1s ease-out infinite" }} />
                          )}
                        </div>
                      )}
                      {m.radar && <RadarLista items={m.radar} onNavegar={navegar} />}
                      {m.bloques?.map((b, j) => (
                        <Bloque key={j} b={b} onNavegar={navegar} onConfirmar={confirmarAccion} accionEstado={accionEstado} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Indicador "analizando" cuando aún no llega texto */}
            {escribiendo && mensajes.length > 0 && mensajes[mensajes.length - 1].texto === "" && (
              <div className="flex gap-2 items-center pl-8" style={{ animation: "eliaMsg 0.25s ease-out" }}>
                <div className="bg-white border border-[#E4E7ED] px-3 py-2 rounded-2xl rounded-bl-md flex items-center gap-1.5">
                  {[0, 1, 2].map((n) => (
                    <span
                      key={n}
                      className="w-1.5 h-1.5 rounded-full bg-[#2f8ee9]"
                      style={{ animation: `eliaDots 1.2s ease-in-out ${n * 0.18}s infinite` }}
                    />
                  ))}
                  {estadoTool && <span className="text-[10.5px] text-[#5B6B82] ml-1">{estadoTool}</span>}
                </div>
              </div>
            )}

            {/* Chips de sugerencias */}
            {mostrarChips && chipsVisibles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-8 pt-1">
                {chipsVisibles.map((c) => (
                  <button
                    key={c}
                    onClick={() => enviar(c)}
                    className="bg-white border border-[#2f8ee9]/35 text-[#1262bd] hover:bg-[#2f8ee9]/10 text-[11px] font-semibold px-3 py-1.5 rounded-full transition-colors"
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}

            <div ref={finRef} />
          </div>

          {/* Input */}
          <div className="flex-shrink-0 px-3.5 pb-3.5 pt-2 bg-[#f6f9fc] border-t border-[#E4E7ED]">
            <div className="flex items-end gap-2 bg-white border border-[#E4E7ED] rounded-2xl px-3 py-2 focus-within:border-[#2f8ee9]/60 focus-within:ring-2 focus-within:ring-[#2f8ee9]/15 transition-all">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    enviar();
                  }
                }}
                rows={1}
                placeholder="Pregúntame lo que necesites…"
                className="flex-1 resize-none outline-none text-[12.5px] text-[#1f3a5f] placeholder:text-[#8693A6] bg-transparent max-h-24 leading-relaxed"
                style={{ minHeight: 20 }}
              />
              <button
                onClick={() => enviar()}
                disabled={escribiendo || !input.trim()}
                title="Enviar"
                className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-xl bg-[#0b315f] hover:bg-[#1262bd] disabled:opacity-35 text-white transition-all"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
            <p className="text-[9px] text-[#8693A6] text-center mt-1.5">
              ELIA consulta datos reales del ERP y puede equivocarse — verifica lo crítico.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
