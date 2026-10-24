"use client";
// /licitaciones — Lista de licitaciones, legajo de la empresa y catálogo de experiencia.
//
// Tres pestañas con deep-link (?tab=licitaciones | legajo | experiencia). Cada pestaña lee SUS datos
// por lib/licitaciones/datos.ts; solo se monta la activa. El editor de cada licitación vive en
// /licitaciones/[id]. El gate real es app/layout.tsx (módulo «licitaciones»); usePermiso es la guarda
// fina de la pantalla.

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePermiso } from "@/lib/usePermiso";
import ListaLicitaciones from "@/components/licitaciones/ListaLicitaciones";
import TabLegajo from "@/components/licitaciones/TabLegajo";
import TabExperiencia from "@/components/licitaciones/TabExperiencia";
import { AZUL } from "@/components/licitaciones/ui";

const TABS = [
  { key: "licitaciones", label: "📑 Licitaciones", Comp: ListaLicitaciones },
  { key: "legajo", label: "🗂️ Legajo de la empresa", Comp: TabLegajo },
  { key: "experiencia", label: "🏅 Experiencia", Comp: TabExperiencia },
] as const;
type ClaveTab = (typeof TABS)[number]["key"];

function Interno() {
  const router = useRouter();
  const params = useSearchParams();
  const pedido = params.get("tab");
  const activa: ClaveTab = TABS.find((t) => t.key === pedido)?.key ?? "licitaciones";
  const Activa = (TABS.find((t) => t.key === activa) ?? TABS[0]).Comp;

  return (
    <main className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Licitaciones</h1>
        <p className="text-gray-400 text-sm mt-1">Propuestas técnicas y expedientes para concursos y licitaciones de transporte de personal.</p>
      </div>
      <div className="flex gap-1 border-b overflow-x-auto" role="tablist" aria-label="Secciones de Licitaciones">
        {TABS.map((t) => {
          const on = t.key === activa;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on}
              onClick={() => router.push(t.key === "licitaciones" ? "/licitaciones" : `/licitaciones?tab=${t.key}`)}
              className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap min-h-[44px]"
              style={{ borderColor: on ? AZUL : "transparent", color: on ? AZUL : "#9ca3af" }}>
              {t.label}
            </button>
          );
        })}
      </div>
      <Activa />
    </main>
  );
}

function Guarda() {
  const { validando, permitido } = usePermiso("licitaciones");
  if (validando || !permitido) return <div className="p-6 text-sm text-gray-400">Comprobando el permiso del módulo Licitaciones…</div>;
  return <Interno />;
}

export default function LicitacionesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Cargando…</div>}>
      <Guarda />
    </Suspense>
  );
}
