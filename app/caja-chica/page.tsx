"use client";

// Hub de Caja Chica: una sola página con pestañas y deep-link (?tab=).
//
// La banda KPI vive AQUÍ y no dentro de una pestaña: "dinero en la calle" es el
// semáforo del módulo entero y quien está revisando comprobantes o editando fondos
// necesita verlo igual que quien mira la bandeja de rendiciones.

import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import { hoyLima } from "@/lib/finanzas/caja-chica";
import RendicionesTab from "./_tabs/RendicionesTab";
import RevisionTab from "./_tabs/RevisionTab";
import FondosTab from "./_tabs/FondosTab";

// Todas las pestañas comparten firma: reciben el gatillo para refrescar la banda KPI
// cuando mueven dinero (entregar, aprobar, activar un fondo…).
type TabComp = React.ComponentType<{ onCambio: () => void }>;

const TABS: { key: string; label: string; Comp: TabComp }[] = [
  { key: "rendiciones", label: "🧾 Rendiciones", Comp: RendicionesTab },
  { key: "revision", label: "🔍 Por revisar", Comp: RevisionTab },
  { key: "fondos", label: "💰 Fondos", Comp: FondosTab },
];

type FilaSaldo = {
  rendiciones_vivas: number | null;
  rendiciones_atrasadas: number | null;
  saldo_en_calle: number | null;
};

type FilaRendicionKpi = {
  estado: string;
  atrasada: boolean | null;
};

type FilaMonto = { monto: number | null };

type Resumen = {
  enCalle: number;
  responsables: number;
  vivas: number;
  atrasadasFondo: number;
  porRevisar: number;
  atrasadas: number;
  rendidoMes: number;
  comprobantesPendientes: number;
  totalRendiciones: number;
  totalFondos: number;
};

const RESUMEN_VACIO: Resumen = {
  enCalle: 0,
  responsables: 0,
  vivas: 0,
  atrasadasFondo: 0,
  porRevisar: 0,
  atrasadas: 0,
  rendidoMes: 0,
  comprobantesPendientes: 0,
  totalRendiciones: 0,
  totalFondos: 0,
};

function HubInterno() {
  const router = useRouter();
  const params = useSearchParams();
  const pedido = params.get("tab");
  const activa = TABS.find((t) => t.key === pedido)?.key ?? TABS[0].key;
  const Activa = (TABS.find((t) => t.key === activa) ?? TABS[0]).Comp;

  const [resumen, setResumen] = useState<Resumen>(RESUMEN_VACIO);

  const cargarResumen = useCallback(async () => {
    // El primer día del mes en hora de Lima: hoyLima() ya viene desfasado a UTC-5.
    const primerDiaMes = hoyLima().slice(0, 8) + "01";

    const [saldos, rendiciones, gastosMes, pendientes] = await Promise.all([
      supabase.from("v_caja_chica_saldos").select("rendiciones_vivas, rendiciones_atrasadas, saldo_en_calle"),
      supabase.from("v_caja_chica_rendiciones").select("estado, atrasada"),
      supabase.from("caja_chica_gastos").select("monto").gte("fecha", primerDiaMes).neq("estado_revision", "rechazado"),
      supabase.from("caja_chica_gastos").select("id", { count: "exact", head: true }).eq("estado_revision", "pendiente"),
    ]);

    const s = (saldos.data ?? []) as FilaSaldo[];
    const r = (rendiciones.data ?? []) as FilaRendicionKpi[];
    const g = (gastosMes.data ?? []) as FilaMonto[];

    setResumen({
      enCalle: redondear(s.reduce((acc, f) => acc + Number(f.saldo_en_calle ?? 0), 0)),
      responsables: s.filter((f) => Number(f.rendiciones_vivas ?? 0) > 0).length,
      vivas: s.reduce((acc, f) => acc + Number(f.rendiciones_vivas ?? 0), 0),
      atrasadasFondo: s.reduce((acc, f) => acc + Number(f.rendiciones_atrasadas ?? 0), 0),
      porRevisar: r.filter((f) => f.estado === "por_revisar").length,
      atrasadas: r.filter((f) => f.atrasada).length,
      rendidoMes: redondear(g.reduce((acc, f) => acc + Number(f.monto ?? 0), 0)),
      comprobantesPendientes: Number(pendientes.count ?? 0),
      totalRendiciones: r.length,
      totalFondos: s.length,
    });
  }, []);

  // La carga inicial es el patrón de todo el ERP (cargar() al montar). La regla del
  // linter apunta a otro caso —setState síncrono en el cuerpo del efecto—; aquí el
  // estado se escribe dentro de una promesa ya resuelta.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarResumen();
  }, [cargarResumen]);

  const kpis = [
    { label: "Por revisar", valor: String(resumen.porRevisar), color: "#854d0e", bg: "#fef9c3" },
    { label: "Atrasadas", valor: String(resumen.atrasadas), color: "#991b1b", bg: "#fee2e2" },
    { label: "Rendido este mes", valor: fmtMoneda(resumen.rendidoMes), color: "#166534", bg: "#dcfce7" },
    { label: "Comprobantes pendientes", valor: String(resumen.comprobantesPendientes), color: "#0b315f", bg: "#eef3f8" },
  ];

  const contador = (clave: string): number => {
    if (clave === "rendiciones") return resumen.totalRendiciones;
    if (clave === "revision") return resumen.porRevisar;
    return resumen.totalFondos;
  };

  return (
    <div>
      <div className="max-w-7xl mx-auto px-6 pt-6 space-y-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Caja chica</h1>
            <p className="text-gray-400 text-sm mt-1">
              Entregas a rendir · Comprobantes con foto · Fondos por responsable
            </p>
          </div>
        </div>

        {/* Banda navy: el número que manda en el módulo. */}
        <section className="rounded-2xl border-2 p-4" style={{ background: "#0b315f", borderColor: "#0b315f" }}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200 mb-1">Dinero en la calle</p>
          <p className="text-4xl font-black text-white">{fmtMoneda(resumen.enCalle)}</p>
          <p className="text-blue-200 text-xs mt-1">
            {resumen.responsables} responsable{resumen.responsables === 1 ? "" : "s"} · {resumen.vivas} rendición
            {resumen.vivas === 1 ? "" : "es"} abierta{resumen.vivas === 1 ? "" : "s"} · {resumen.atrasadasFondo} atrasada
            {resumen.atrasadasFondo === 1 ? "" : "s"}
          </p>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>
                {k.label}
              </p>
              <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>
                {k.valor}
              </p>
            </div>
          ))}
        </section>

        <div className="flex gap-1 border-b overflow-x-auto">
          {TABS.map((t) => {
            const on = t.key === activa;
            return (
              <button
                key={t.key}
                onClick={() => router.push(`/caja-chica?tab=${t.key}`)}
                className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
                style={{ borderColor: on ? "#0b315f" : "transparent", color: on ? "#0b315f" : "#9ca3af" }}
              >
                {t.label} ({contador(t.key)})
              </button>
            );
          })}
        </div>
      </div>

      {/* Solo se monta la pestaña activa; cada una trae su propio <main>. */}
      <Activa onCambio={cargarResumen} />
    </div>
  );
}

export default function CajaChicaHub() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Cargando…</div>}>
      <HubInterno />
    </Suspense>
  );
}
