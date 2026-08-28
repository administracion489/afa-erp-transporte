"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /pactos — El gobierno del cambio de servicio.
//
// Responde las tres preguntas que hoy nadie puede contestar sin abrir el cierre del mes:
//   · ¿Qué servicios tercerizados nadie pactó, y cuáles YA se ejecutaron así?
//   · ¿Qué cambios bajaron el margen y siguen sin visto bueno?
//   · ¿Quién cambió qué, cuándo y por qué?
//
// La banda de KPIs vive AQUÍ y no dentro de una pestaña: el pasivo sin pactar es el
// semáforo del módulo entero, y quien está visando o revisando el historial necesita
// verlo igual que quien trabaja la bandeja.
//
// LA CUENTA DE CONTROL es el KPI más importante y el que menos se mira: compara el
// acta contra la realidad y DEBE dar cero. Cualquier fila es una escritura que esquivó
// el trigger — y hasta que esté en cero, subir la guardia (fase 4) rompería cosas.
//
// Requiere supabase/pacto-00 a pacto-04. Sin ellas cada pestaña dice qué falta correr
// en vez de romperse.
// ──────────────────────────────────────────────────────────────────────────────
import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import SinCostoTab from "./_tabs/SinCostoTab";
import PorVisarTab from "./_tabs/PorVisarTab";
import HistorialTab from "./_tabs/HistorialTab";

type TabComp = React.ComponentType<{ onCambio: () => void }>;

const TABS: { key: string; label: string; Comp: TabComp }[] = [
  { key: "sin-costo",  label: "🔴 Sin costo pactado", Comp: SinCostoTab },
  { key: "por-visar",  label: "✋ Por visar",          Comp: PorVisarTab },
  { key: "historial",  label: "📜 Historial",         Comp: HistorialTab },
];

type Resumen = {
  pendientes: number;
  ejecutadosSinCosto: number;
  porVisar: number;
  visadosVencidos: number;
  impactoPorVisar: number;
  descuadres: number | null;
  guardia: string | null;
  faltaSql: boolean;
};

const VACIO: Resumen = {
  pendientes: 0, ejecutadosSinCosto: 0, porVisar: 0, visadosVencidos: 0,
  impactoPorVisar: 0, descuadres: null, guardia: null, faltaSql: false,
};

function PactosHub() {
  const router = useRouter();
  const params = useSearchParams();
  const tabUrl = params.get("tab");
  const activa = TABS.find((t) => t.key === tabUrl)?.key ?? TABS[0].key;

  const [resumen, setResumen] = useState<Resumen>(VACIO);
  const [cargando, setCargando] = useState(true);

  const cargarResumen = useCallback(async () => {
    setCargando(true);
    const [sinCosto, porVisar, descuadres, politica] = await Promise.all([
      supabase.from("v_servicios_sin_costo").select("cubierto_por_par,urgencia").limit(5000),
      supabase.from("v_pactos_por_visar").select("delta,vencido").limit(1000),
      supabase.from("v_pactos_descuadrados").select("reserva_id").limit(1000),
      supabase.from("pacto_politica").select("guardia_modo").eq("id", 1).maybeSingle(),
    ]);

    const filas = (sinCosto.data as any[]) ?? [];
    const pend = filas.filter((f) => !f.cubierto_por_par);
    const visar = (porVisar.data as any[]) ?? [];

    setResumen({
      pendientes: pend.length,
      ejecutadosSinCosto: pend.filter((f) => f.urgencia === "ejecutado_sin_costo").length,
      porVisar: visar.length,
      visadosVencidos: visar.filter((v) => v.vencido).length,
      impactoPorVisar: visar.reduce((a, v) => a + Number(v.delta ?? 0), 0),
      // null = la vista no existe todavía; 0 = existe y está cuadrada. No es lo mismo.
      descuadres: descuadres.error ? null : ((descuadres.data as any[]) ?? []).length,
      guardia: politica.error ? null : (politica.data?.guardia_modo ?? null),
      faltaSql: !!sinCosto.error,
    });
    setCargando(false);
  }, []);

  useEffect(() => { cargarResumen(); }, [cargarResumen]);

  const Activa = TABS.find((t) => t.key === activa)!.Comp;
  const irA = (key: string) => router.replace(key === TABS[0].key ? "/pactos" : `/pactos?tab=${key}`);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl font-black text-gray-900">Pactos del servicio</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Lo que se acordó pagar y cobrar por cada servicio, y todo lo que cambió después.
        </p>
      </header>

      {resumen.faltaSql && (
        <div className="mb-4 rounded-2xl px-4 py-3 text-sm bg-amber-50 border border-amber-200 text-amber-800">
          Faltan correr las migraciones del Pacto en Supabase, en orden:{" "}
          <b>pacto-00-tributario</b> → <b>pacto-01-costeo</b> → <b>pacto-02-acta</b> →{" "}
          <b>pacto-03-triggers</b> → <b>pacto-04-apertura</b>.
        </div>
      )}

      {/* ── Banda de semáforos ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <Kpi label="Sin costo pactado" valor={cargando ? "…" : String(resumen.pendientes)}
          sub="decisiones reales" color="#b91c1c"
          onClick={() => irA("sin-costo")} />
        <Kpi label="Ya ejecutados" valor={cargando ? "…" : String(resumen.ejecutadosSinCosto)}
          sub="el proveedor ya trabajó" color="#c2410c"
          onClick={() => irA("sin-costo")} />
        <Kpi label="Por visar" valor={cargando ? "…" : String(resumen.porVisar)}
          sub={resumen.visadosVencidos ? `${resumen.visadosVencidos} vencido(s)` : "al día"}
          color={resumen.visadosVencidos ? "#b91c1c" : "#0369a1"}
          onClick={() => irA("por-visar")} />
        <Kpi label="Impacto por visar" valor={cargando ? "…" : fmtMoneda(resumen.impactoPorVisar)}
          sub="mayor costo sin autorizar" color={resumen.impactoPorVisar > 0 ? "#b91c1c" : "#166534"}
          onClick={() => irA("por-visar")} />
        {/* La cuenta de control. Debe decir "cuadrado". Si no, hay una escritura que
            esquivó el trigger y subir la guardia rompería cosas. */}
        <Kpi label="Cuenta de control"
          valor={cargando ? "…" : resumen.descuadres == null ? "—" : resumen.descuadres === 0 ? "Cuadrado" : String(resumen.descuadres)}
          sub={resumen.descuadres == null ? "sin migrar"
             : resumen.descuadres === 0 ? "acta = realidad" : "escrituras sin acta"}
          color={resumen.descuadres === 0 ? "#166534" : resumen.descuadres == null ? "#94a3b8" : "#b91c1c"} />
      </div>

      {resumen.guardia && (
        <div className="mb-4 text-[11px] text-gray-500">
          Guardia en modo <b className="text-gray-700">{resumen.guardia}</b>
          {resumen.guardia === "observa" && " — el sistema registra pero no bloquea ninguna escritura todavía."}
        </div>
      )}

      <div className="flex gap-2 mb-4 border-b overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => irA(t.key)}
            className={`px-4 py-2 text-sm font-bold whitespace-nowrap border-b-2 -mb-px transition-colors ${
              activa === t.key
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            {t.label}
          </button>
        ))}
      </div>

      <Activa onCambio={cargarResumen} />
    </div>
  );
}

function Kpi({ label, valor, sub, color, onClick }: {
  label: string; valor: string; sub: string; color: string; onClick?: () => void;
}) {
  const Tag: any = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick}
      className={`bg-white rounded-2xl border shadow-sm px-4 py-3 text-left ${onClick ? "hover:border-gray-300 transition-colors" : ""}`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-400 font-bold">{label}</p>
      <p className="text-xl font-black tabular-nums mt-0.5" style={{ color }}>{valor}</p>
      <p className="text-[11px] text-gray-400">{sub}</p>
    </Tag>
  );
}

export default function PactosPage() {
  // useSearchParams exige Suspense en el App Router.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Cargando…</div>}>
      <PactosHub />
    </Suspense>
  );
}
