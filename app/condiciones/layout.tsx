// Layout server-side SOLO para aportar viewport y metadata a la página pública de condiciones
// (/condiciones/[token]): el root layout (app/layout.tsx) es "use client" y no puede exportarlos.
// `noindex`: es la política de UNA cotización, que se abre con su enlace; no tiene que salir en un
// buscador (la API ya responde con X-Robots-Tag: noindex, esto cubre la página).
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0b315f",
};

export const metadata: Metadata = {
  title: "Condiciones de reserva, cambios y cancelación",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function CondicionesLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
