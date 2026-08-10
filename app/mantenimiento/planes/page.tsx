"use client";

// Los Planes del Fabricante pasaron a ser una pestaña del hub de Mantenimiento
// (antes vivían en esta ruta aparte). Se deja el redirect para no romper enlaces
// guardados/marcadores.

import { redirect } from "next/navigation";

export default function PlanesRedirect() {
  redirect("/mantenimiento?tab=planes");
}
