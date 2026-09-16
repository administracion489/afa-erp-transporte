"use client";
// app/redes/PanelAjustes.tsx — Lo que la IA necesita saber para redactar como la
// empresa, y el interruptor general.
//
// NADA DE ESTO VIVE EN EL CÓDIGO, Y ES LA MISMA RAZÓN QUE `autorizacion_mtc`: **este ERP
// se vende**. Un tono, un público o unos hashtags escritos como constante los heredaría
// el primer comprador, y su cuenta publicaría con la voz de AFA. Se teclean una vez por
// empresa y viven en `redes_config`.
//
// El campo PROHIBIDO no es decorativo: es lo que evita que la IA escriba el nombre de un
// cliente o una tarifa en un post público. El prompt ya prohíbe inventar cifras (ver
// lib/redes/ia.ts); esto es lo que cada empresa añade por encima.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { hhmm } from "@/lib/redes/plan";

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";
const btn = "px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-40";

type Cfg = {
  activo: boolean;
  hora_propuesta_min: number;
  hora_publicar_min: number;
  tono: string | null;
  publico: string | null;
  prohibido: string | null;
  hashtags_fijos: string | null;
  temas: string[] | null;
  modelo: string | null;
};

const VACIA: Cfg = {
  activo: false,
  hora_propuesta_min: 360,
  hora_publicar_min: 480,
  tono: "",
  publico: "",
  prohibido: "",
  hashtags_fijos: "",
  temas: [],
  modelo: "claude-opus-5",
};

function minAHhmm(m: number): string {
  return hhmm(m);
}
function hhmmAMinutos(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export default function PanelAjustes() {
  const [cfg, setCfg] = useState<Cfg>(VACIA);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data } = await supabase.from("redes_config").select("*").eq("id", 1).maybeSingle();
    if (data) setCfg({ ...VACIA, ...(data as any) });
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function guardar() {
    setGuardando(true);
    const { error } = await supabase
      .from("redes_config")
      .update({
        activo: cfg.activo,
        hora_propuesta_min: cfg.hora_propuesta_min,
        hora_publicar_min: cfg.hora_publicar_min,
        // Campos de TEXTO: vaciarlos escribe null, no "". Un tono puesto por error tiene
        // que poder RETIRARSE, no solo cambiarse — el agujero que tuvo `capacidad_tanque`.
        tono: cfg.tono?.trim() || null,
        publico: cfg.publico?.trim() || null,
        prohibido: cfg.prohibido?.trim() || null,
        hashtags_fijos: cfg.hashtags_fijos?.trim() || null,
        temas: (cfg.temas ?? []).filter((t) => t.trim()),
        modelo: cfg.modelo || null,
        actualizado_en: new Date().toISOString(),
      })
      .eq("id", 1);
    setGuardando(false);
    setMsg(error ? error.message : "Guardado.");
    setTimeout(() => setMsg(null), 4000);
  }

  if (cargando) return <div className="text-sm text-gray-400 py-6">Cargando ajustes…</div>;

  const propuestaDespues = cfg.hora_propuesta_min >= cfg.hora_publicar_min;

  return (
    <div className="space-y-4 max-w-2xl">
      {msg && <div className="rounded-xl bg-gray-100 px-4 py-2.5 text-sm text-gray-700">{msg}</div>}

      <div className="rounded-2xl border border-gray-200 p-5">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.activo}
            onChange={(e) => setCfg({ ...cfg, activo: e.target.checked })}
            className="mt-1"
          />
          <div>
            <div className="text-sm font-semibold text-gray-800">Agente de redes encendido</div>
            <div className="text-xs text-gray-500 mt-0.5">
              Apagado, el cron no redacta ni publica nada — y no gasta ni un token de Claude. Puedes seguir
              usando la pestaña <b>Hoy</b> a mano.
            </div>
          </div>
        </label>
      </div>

      <div className="rounded-2xl border border-gray-200 p-5 grid sm:grid-cols-2 gap-4">
        <div>
          <label className={label}>Hora de la propuesta</label>
          <input
            type="time"
            className={input}
            value={minAHhmm(cfg.hora_propuesta_min)}
            onChange={(e) => setCfg({ ...cfg, hora_propuesta_min: hhmmAMinutos(e.target.value) })}
          />
          <p className="mt-1 text-xs text-gray-400">A esta hora la IA deja el texto listo para que lo revises.</p>
        </div>
        <div>
          <label className={label}>Hora de publicación</label>
          <input
            type="time"
            className={input}
            value={minAHhmm(cfg.hora_publicar_min)}
            onChange={(e) => setCfg({ ...cfg, hora_publicar_min: hhmmAMinutos(e.target.value) })}
          />
          <p className="mt-1 text-xs text-gray-400">
            Solo sale lo aprobado. Si a esta hora no lo aprobaste, espera a que lo hagas.
          </p>
        </div>
        {/* Entre las dos horas está el rato en que una persona lo lee. Con la propuesta
            después de la publicación, la aprobación es imposible de cumplir y el post
            del día simplemente no sale — sin que nada lo explique. */}
        {propuestaDespues && (
          <div className="sm:col-span-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
            La propuesta se redacta <b>después</b> de la hora de publicación. Así no queda tiempo para
            aprobarla y el post del día no saldrá. Deja la propuesta antes: por ejemplo 06:00 y 08:00.
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-gray-200 p-5 space-y-4">
        <div>
          <label className={label}>Tono de la marca</label>
          <textarea
            rows={3}
            className={input}
            value={cfg.tono ?? ""}
            onChange={(e) => setCfg({ ...cfg, tono: e.target.value })}
            placeholder="Cercano y directo, sin jerga corporativa. Trata de usted. Frases cortas."
          />
        </div>
        <div>
          <label className={label}>A quién le habla</label>
          <textarea
            rows={3}
            className={input}
            value={cfg.publico ?? ""}
            onChange={(e) => setCfg({ ...cfg, publico: e.target.value })}
            placeholder="Jefes de logística y RR. HH. de empresas que necesitan mover a su personal en Lima."
          />
        </div>
        <div>
          <label className={label}>Prohibido mencionar</label>
          <textarea
            rows={3}
            className={input}
            value={cfg.prohibido ?? ""}
            onChange={(e) => setCfg({ ...cfg, prohibido: e.target.value })}
            placeholder="Nombres de clientes, tarifas, placas, rutas concretas, nombres de conductores."
          />
          <p className="mt-1 text-xs text-gray-400">
            La IA ya tiene prohibido inventar cifras, años de experiencia y superlativos. Esto es lo que
            añade tu empresa por encima.
          </p>
        </div>
        <div>
          <label className={label}>Hashtags fijos</label>
          <input
            className={input}
            value={cfg.hashtags_fijos ?? ""}
            onChange={(e) => setCfg({ ...cfg, hashtags_fijos: e.target.value })}
            placeholder="#TransporteDePersonal #Lima"
          />
        </div>
        <div>
          <label className={label}>Temas que rotan (uno por línea)</label>
          <textarea
            rows={5}
            className={input}
            value={(cfg.temas ?? []).join("\n")}
            onChange={(e) => setCfg({ ...cfg, temas: e.target.value.split("\n") })}
            placeholder={"Seguridad a bordo\nPuntualidad\nEl equipo detrás del servicio\nMantenimiento de la flota"}
          />
          <p className="mt-1 text-xs text-gray-400">
            Se recorren en orden por día, no al azar: así el canal no repite el mismo tema tres días seguidos.
          </p>
        </div>
      </div>

      <button onClick={guardar} disabled={guardando} className={`${btn} bg-[#0b315f] text-white`}>
        {guardando ? "Guardando…" : "Guardar ajustes"}
      </button>
    </div>
  );
}
