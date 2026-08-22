"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Hub de Cuentas por Pagar y Tesorería: una sola página con pestañas y deep-link.
//
// Cada pestaña carga SUS PROPIOS datos y trae su propio <main>: no se les pasa nada
// por props. Lo único que vive aquí son los CONTADORES del rótulo de cada pestaña —
// consultas `head: true` que no traen filas, solo el número — para que quien entre vea
// de un vistazo dónde está el trabajo pendiente sin tener que abrir las cinco.
// ──────────────────────────────────────────────────────────────────────────────

import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import CuentasPorPagarTab from "./_tabs/CuentasPorPagarTab";
import PlanillaTab from "./_tabs/PlanillaTab";
import DetraccionesTab from "./_tabs/DetraccionesTab";
import LotesTab from "./_tabs/LotesTab";
import ConciliacionTab from "./_tabs/ConciliacionTab";

const TABS = [
  { key: "cxp", label: "🧾 Cuentas por pagar", Comp: CuentasPorPagarTab },
  { key: "planilla", label: "💼 Planilla y admin.", Comp: PlanillaTab },
  { key: "detracciones", label: "🏦 Detracciones", Comp: DetraccionesTab },
  { key: "lotes", label: "📦 Lotes de pago", Comp: LotesTab },
  { key: "conciliacion", label: "🔗 Conciliación", Comp: ConciliacionTab },
] as const;

type ClaveTab = (typeof TABS)[number]["key"];

type Contadores = Record<ClaveTab, number>;

const SIN_CONTAR: Contadores = { cxp: 0, planilla: 0, detracciones: 0, lotes: 0, conciliacion: 0 };

function HubInterno() {
  const router = useRouter();
  const params = useSearchParams();
  const pedido = params.get("tab");
  const activa: ClaveTab = TABS.find((t) => t.key === pedido)?.key ?? TABS[0].key;
  const Activa = (TABS.find((t) => t.key === activa) ?? TABS[0]).Comp;

  const [contadores, setContadores] = useState<Contadores>(SIN_CONTAR);

  const contar = useCallback(async () => {
    const soloCuenta = { count: "exact" as const, head: true };
    const [cxp, planilla, detracciones, lotes, fugas] = await Promise.all([
      supabase.from("v_cuentas_por_pagar").select("id", soloCuenta).neq("estado_pago", "pagada"),
      // Un gasto rechazado ya no es trabajo pendiente aunque siga figurando impago.
      supabase.from("gastos_generales").select("id", soloCuenta).neq("estado_pago", "pagada").neq("estado_aprobacion", "rechazado"),
      supabase.from("v_detracciones_pendientes").select("origen_id", soloCuenta).eq("lado", "compra"),
      supabase.from("lotes_pago").select("id", soloCuenta).in("estado", ["borrador", "aprobado", "enviado_banco"]),
      supabase.from("v_fugas_bancarias").select("id", soloCuenta),
    ]);
    setContadores({
      cxp: Number(cxp.count ?? 0),
      planilla: Number(planilla.count ?? 0),
      detracciones: Number(detracciones.count ?? 0),
      lotes: Number(lotes.count ?? 0),
      conciliacion: Number(fugas.count ?? 0),
    });
  }, []);

  // Se recuentan al montar y al cambiar de pestaña: lo que se hizo en una pestaña
  // suele mover el pendiente de otra (aprobar una CxP la saca de la bandeja).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    contar();
  }, [contar, activa]);

  return (
    <div>
      <div className="max-w-7xl mx-auto px-6 pt-6">
        <div className="flex gap-1 border-b overflow-x-auto">
          {TABS.map((t) => {
            const on = t.key === activa;
            return (
              <button
                key={t.key}
                onClick={() => router.push(`/tesoreria?tab=${t.key}`)}
                className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
                style={{ borderColor: on ? "#0b315f" : "transparent", color: on ? "#0b315f" : "#9ca3af" }}
              >
                {t.label} ({contadores[t.key]})
              </button>
            );
          })}
        </div>
      </div>

      {/* Solo se monta la pestaña activa; cada una trae su propio <main>. */}
      <Activa />
    </div>
  );
}

export default function TesoreriaHub() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Cargando…</div>}>
      <HubInterno />
    </Suspense>
  );
}
