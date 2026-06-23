// Layout server-side SOLO para aportar viewport/metadata a la app del pasajero.
// El root layout (app/layout.tsx) es "use client" y no puede exportar `viewport`,
// por eso sin esto faltaba el <meta viewport> (la app se renderizaba a escala
// desktop en algunos móviles/WebViews) y no había `viewport-fit=cover` para
// usar las safe-area-inset del notch/barra gestual.
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",       // habilita env(safe-area-inset-*)
  themeColor: "#0b315f",
};

export const metadata: Metadata = {
  title: "AFA Pasajero",
  description: "Sigue tu bus AFA en vivo y aborda con tu pase QR.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "AFA Pasajero" },
  icons: { apple: "/icon-afa-pasajero.png" },
};

export default function PasajeroLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
