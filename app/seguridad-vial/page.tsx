"use client";

// Seguridad vial: los excesos de velocidad sostenidos y corroborados de la flota.
// La pantalla vive en components/flota/SeguridadVial.tsx; aquí solo va la guarda del módulo
// `monitoreo` (el mismo que exige /api/flota/excesos y el de /gps-salud). El servidor vuelve a
// verificar el permiso en cada llamada: esta guarda es la de la pantalla, no la de los datos.

import SeguridadVial from "@/components/flota/SeguridadVial";
import { usePermiso } from "@/lib/usePermiso";

export default function SeguridadVialPage() {
  const { validando, permitido } = usePermiso("monitoreo");
  if (validando || !permitido) {
    return <p className="p-2 text-sm text-gray-500">Validando el permiso del módulo Monitoreo…</p>;
  }
  return <SeguridadVial />;
}
