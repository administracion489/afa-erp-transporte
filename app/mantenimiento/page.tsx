"use client";

// Hub de Mantenimiento: una sola página con pestañas.
// Cada pestaña es la página original, reubicada como componente en ./_tabs
// (módulos separados = sin colisiones de helpers/tipos entre páginas).
// La pestaña activa vive en la URL (?tab=) para deep-link y refresco.

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ProgramaTab from "./_tabs/ProgramaTab";
import OrdenesTab from "./_tabs/OrdenesTab";
import HistorialTab from "./_tabs/HistorialTab";
import OdometroTab from "./_tabs/OdometroTab";
import PlanesTab from "./_tabs/PlanesTab";

const TABS = [
  { key: "proximos",  label: "Próximos",            Comp: ProgramaTab },
  { key: "ordenes",   label: "Órdenes de Trabajo",  Comp: OrdenesTab },
  { key: "planes",    label: "Planes Fabricante",   Comp: PlanesTab },
  { key: "historial", label: "Historial",           Comp: HistorialTab },
  { key: "odometro",  label: "Odómetro",            Comp: OdometroTab },
] as const;

function HubInterno() {
  const router = useRouter();
  const params = useSearchParams();
  const pedido = params.get("tab");
  const activa = TABS.find((t) => t.key === pedido)?.key ?? "proximos";
  const Activa = (TABS.find((t) => t.key === activa) ?? TABS[0]).Comp;

  return (
    <div>
      {/* Barra de pestañas (alineada con el contenido, que trae su propio max-w-7xl) */}
      <div className="max-w-7xl mx-auto px-6 pt-6">
        <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
          {TABS.map((t) => {
            const on = t.key === activa;
            return (
              <button
                key={t.key}
                onClick={() => router.push(`/mantenimiento?tab=${t.key}`)}
                className={`px-4 py-2.5 text-sm font-bold whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  on
                    ? "border-[#0b315f] text-[#0b315f]"
                    : "border-transparent text-gray-400 hover:text-gray-600"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Contenido de la pestaña activa (se monta solo la activa, con su propio <main>) */}
      <Activa />
    </div>
  );
}

export default function MantenimientoHub() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Cargando…</div>}>
      <HubInterno />
    </Suspense>
  );
}
