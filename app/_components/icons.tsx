// Iconos SVG inline estilo Lucide — stroke 1.75, viewBox 24×24, round caps.
// Mantenidos como SVG inline para evitar dependencia extra (lucide-react).
// Espejo del set en design_handoff_apps_pasajero_conductor/prototypes/icons{,-driver}.jsx.

import type { SVGProps } from "react";

type IconProps = {
  size?: number;
  color?: string;
  sw?: number;
  fill?: string;
  className?: string;
  style?: SVGProps<SVGSVGElement>["style"];
};

function Ico({
  children, size = 20, color = "currentColor", sw = 1.75, fill = "none", className, style,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "block", ...style }}
    >
      {children}
    </svg>
  );
}

// ─── COMPARTIDOS (pasajero + conductor) ─────────────────────────────────────

export const IconBus = (p: IconProps) => (
  <Ico {...p}>
    <path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h20"/>
    <path d="M4 19h2a1 1 0 0 0 1-1v-2h10v2a1 1 0 0 0 1 1h2"/>
    <path d="M4 18V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10"/>
    <circle cx="8" cy="16" r="1" fill={p.color || "currentColor"} stroke="none"/>
    <circle cx="16" cy="16" r="1" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

export const IconMap = (p: IconProps) => (
  <Ico {...p}>
    <path d="M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z"/>
    <path d="M9 4v14"/><path d="M15 6v14"/>
  </Ico>
);

export const IconPin = (p: IconProps) => (
  <Ico {...p}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>
    <circle cx="12" cy="10" r="3"/>
  </Ico>
);

export const IconClock = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 7v5l3 2"/>
  </Ico>
);

export const IconQR = (p: IconProps) => (
  <Ico {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1"/>
    <rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/>
    <path d="M14 14h3v3h-3z"/><path d="M20 14v3"/><path d="M14 20h3"/><path d="M20 20v1"/>
  </Ico>
);

export const IconUser = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="12" cy="8" r="4"/>
    <path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>
  </Ico>
);

export const IconPhone = (p: IconProps) => (
  <Ico {...p}>
    <path d="M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>
  </Ico>
);

export const IconShare = (p: IconProps) => (
  <Ico {...p}>
    <path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>
  </Ico>
);

export const IconArrowRight = (p: IconProps) => (
  <Ico {...p}>
    <path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>
  </Ico>
);

export const IconArrowLeft = (p: IconProps) => (
  <Ico {...p}>
    <path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>
  </Ico>
);

export const IconCheck = (p: IconProps) => (
  <Ico {...p}>
    <path d="M5 12l5 5L20 6"/>
  </Ico>
);

export const IconClose = (p: IconProps) => (
  <Ico {...p}>
    <path d="M6 6l12 12"/><path d="M18 6L6 18"/>
  </Ico>
);

export const IconAlert = (p: IconProps) => (
  <Ico {...p}>
    <path d="M12 3l10 17H2L12 3z"/>
    <path d="M12 10v4"/>
    <circle cx="12" cy="17" r=".5" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

export const IconGauge = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="12" cy="13" r="8"/>
    <path d="M12 13l4-3"/><path d="M12 5v1"/><path d="M19 13h1"/><path d="M4 13h1"/>
  </Ico>
);

export const IconChevronRight = (p: IconProps) => (
  <Ico {...p}>
    <path d="M9 6l6 6-6 6"/>
  </Ico>
);

export const IconNav = (p: IconProps) => (
  <Ico {...p}>
    <path d="M3 11l18-8-8 18-2-8-8-2z"/>
  </Ico>
);

export const IconBell = (p: IconProps) => (
  <Ico {...p}>
    <path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2v1h16v-1l-2-2z"/>
    <path d="M10 20a2 2 0 0 0 4 0"/>
  </Ico>
);

export const IconRoute = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/>
    <path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3"/>
  </Ico>
);

export const IconBuilding = (p: IconProps) => (
  <Ico {...p}>
    <rect x="5" y="4" width="14" height="17" rx="1"/>
    <path d="M9 9h2"/><path d="M13 9h2"/><path d="M9 13h2"/><path d="M13 13h2"/>
    <path d="M10 21v-3h4v3"/>
  </Ico>
);

export const IconLogout = (p: IconProps) => (
  <Ico {...p}>
    <path d="M14 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/>
    <path d="M10 8l-4 4 4 4"/><path d="M6 12h11"/>
  </Ico>
);

export const IconCrosshair = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>
    <path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>
  </Ico>
);

export const IconMail = (p: IconProps) => (
  <Ico {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2"/>
    <path d="M3 7l9 7 9-7"/>
  </Ico>
);

export const IconWhatsapp = (p: IconProps) => (
  <Ico {...p}>
    <path d="M3 21l1.5-4.5A8 8 0 1 1 8 20l-5 1z"/>
    <path d="M8 11c.5 2 2 3.5 4 4l1-1 2 1v2c-3 0-7-2-8-7l2-1 1 2-2 0z" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

// ─── CONDUCTOR ─────────────────────────────────────────────────────────────

export const IconKey = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="8" cy="15" r="4"/>
    <path d="M11 12l9-9"/><path d="M17 6l3 3"/><path d="M15 8l2 2"/>
  </Ico>
);

export const IconShield = (p: IconProps) => (
  <Ico {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>
    <path d="M9 12l2 2 4-4"/>
  </Ico>
);

export const IconScan = (p: IconProps) => (
  <Ico {...p}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
    <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
    <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
    <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
    <path d="M7 12h10"/>
  </Ico>
);

export const IconCamera = (p: IconProps) => (
  <Ico {...p}>
    <path d="M5 7h3l2-2h4l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>
    <circle cx="12" cy="13" r="3.5"/>
  </Ico>
);

export const IconWrench = (p: IconProps) => (
  <Ico {...p}>
    <path d="M14 6a4 4 0 0 1 6 5l-9 9-4-4 9-9a4 4 0 0 1-2-1z"/>
  </Ico>
);

export const IconFuel = (p: IconProps) => (
  <Ico {...p}>
    <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/>
    <path d="M2 21h14"/><path d="M5 9h8"/>
    <path d="M14 8l3 3v6a2 2 0 0 0 2 2v0a2 2 0 0 0 2-2v-7l-3-3"/>
  </Ico>
);

export const IconPlay = (p: IconProps) => (
  <Ico {...p}>
    <path d="M6 4l14 8-14 8V4z" fill={p.color || "currentColor"}/>
  </Ico>
);

export const IconStop = (p: IconProps) => (
  <Ico {...p}>
    <rect x="5" y="5" width="14" height="14" rx="2" fill={p.color || "currentColor"}/>
  </Ico>
);

export const IconUsers = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="9" cy="8" r="4"/>
    <path d="M2 21c0-4 3.5-7 7-7s7 3 7 7"/>
    <circle cx="17" cy="10" r="3"/>
    <path d="M16 14c3 0 6 2 6 6"/>
  </Ico>
);

export const IconFlag = (p: IconProps) => (
  <Ico {...p}>
    <path d="M5 21V5"/><path d="M5 5h11l-2 4 2 4H5"/>
  </Ico>
);

export const IconActivity = (p: IconProps) => (
  <Ico {...p}>
    <path d="M3 12h4l3-8 4 16 3-8h4"/>
  </Ico>
);

export const IconMoreH = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="5" cy="12" r="1.3" fill={p.color || "currentColor"} stroke="none"/>
    <circle cx="12" cy="12" r="1.3" fill={p.color || "currentColor"} stroke="none"/>
    <circle cx="19" cy="12" r="1.3" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

export const IconRefresh = (p: IconProps) => (
  <Ico {...p}>
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/>
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/>
    <path d="M3 16v-4h4"/><path d="M21 8v4h-4"/>
  </Ico>
);

export const IconLightning = (p: IconProps) => (
  <Ico {...p}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

export const IconCalendar = (p: IconProps) => (
  <Ico {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2"/>
    <path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>
  </Ico>
);

export const IconSteering = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="12" cy="12" r="9"/>
    <circle cx="12" cy="12" r="2.5"/>
    <path d="M12 9.5V4.5"/><path d="M9.5 14L5 17"/><path d="M14.5 14L19 17"/>
  </Ico>
);

export const IconCircleAlert = (p: IconProps) => (
  <Ico {...p}>
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 7v6"/>
    <circle cx="12" cy="16.5" r=".5" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

export const IconReceipt = (p: IconProps) => (
  <Ico {...p}>
    <path d="M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3 5 4.5z"/>
    <path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>
  </Ico>
);

export const IconBattery = (p: IconProps) => (
  <Ico {...p}>
    <rect x="2" y="7" width="18" height="10" rx="2"/>
    <path d="M22 11v2"/>
    <rect x="4" y="9" width="11" height="6" rx="1" fill={p.color || "currentColor"} stroke="none"/>
  </Ico>
);

// ─── MARCA AFA — Cóndor (abstracto del logo) ───────────────────────────────

export const CondorMark = ({ size = 24, color = "currentColor" }: { size?: number; color?: string }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 48 24" fill={color} style={{ display: "block" }}>
    <path d="M2 14c4-2 8-2 12 0 2-4 6-6 10-6s8 2 10 6c4-2 8-2 12 0-3-1-6-1-9 1-2 1-4 1-6-1-2-3-5-4-7-4s-5 1-7 4c-2 2-4 2-6 1-3-2-6-2-9-1z"/>
    <circle cx="24" cy="11" r="1.2"/>
  </svg>
);
