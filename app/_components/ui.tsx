// UI primitives — espejo de prototypes/tokens.jsx adaptado a TSX.
// Los colores se leen vía CSS custom properties definidas en app/globals.css.

import type { CSSProperties, ReactNode } from "react";

// ─── Fuente helpers (las CSS vars vienen del root layout) ───────────────────

export const FONT_SANS = "var(--font-sans), system-ui, -apple-system, sans-serif";
export const FONT_MONO = "var(--font-mono), ui-monospace, SFMono-Regular, monospace";

// ─── StatusDot ──────────────────────────────────────────────────────────────

export function StatusDot({
  color = "var(--c-success)",
  pulse = true,
  size = 8,
}: { color?: string; pulse?: boolean; size?: number }) {
  return (
    <span
      style={{
        width: size, height: size, borderRadius: size, background: color,
        display: "inline-block", position: "relative", flexShrink: 0,
      }}
    >
      {pulse && (
        <span
          style={{
            position: "absolute", inset: 0, borderRadius: size, background: color,
            animation: "statusPulse 1.6s ease-out infinite",
          }}
        />
      )}
    </span>
  );
}

// ─── Chip ───────────────────────────────────────────────────────────────────

export function Chip({
  children, color = "var(--c-ink)", bg = "var(--c-soft)", mono = false, sw = false, style,
}: {
  children: ReactNode;
  color?: string;
  bg?: string;
  mono?: boolean;
  sw?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: mono ? FONT_MONO : FONT_SANS,
        fontWeight: sw ? 700 : 600,
        fontSize: 11,
        letterSpacing: mono ? 0.3 : 0.1,
        color, background: bg,
        padding: "4px 10px", borderRadius: 999,
        display: "inline-flex", alignItems: "center", gap: 6,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ─── Eyebrow ────────────────────────────────────────────────────────────────

export function Eyebrow({
  children, color = "var(--c-mute)", style,
}: { children: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <p
      style={{
        fontFamily: FONT_SANS,
        fontSize: 10, fontWeight: 700,
        color, letterSpacing: 1.2, textTransform: "uppercase",
        margin: 0,
        ...style,
      }}
    >
      {children}
    </p>
  );
}

// ─── PrimaryBtn ─────────────────────────────────────────────────────────────

export function PrimaryBtn({
  children, onClick, full = true, color = "var(--c-navy)", fg = "#fff",
  size = "md", icon, disabled = false, type = "button", style,
}: {
  children: ReactNode;
  onClick?: () => void;
  full?: boolean;
  color?: string;
  fg?: string;
  size?: "md" | "lg";
  icon?: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  style?: CSSProperties;
}) {
  const pad = size === "lg" ? "17px 22px" : "14px 20px";
  const fs = size === "lg" ? 16 : 15;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: full ? "100%" : "auto",
        padding: pad, borderRadius: 14, border: "none",
        background: color, color: fg, fontFamily: FONT_SANS,
        fontWeight: 700, fontSize: fs,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        letterSpacing: -0.1,
        boxShadow: "0 1px 0 rgba(0,0,0,0.04), 0 6px 16px -8px rgba(11,49,95,0.4)",
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── SecondaryBtn ───────────────────────────────────────────────────────────

export function SecondaryBtn({
  children, icon, onClick, full = true, disabled = false, type = "button", style,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  full?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  style?: CSSProperties;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: full ? "100%" : "auto",
        padding: "13px 20px", borderRadius: 14,
        background: "var(--c-surface)", color: "var(--c-ink)", fontFamily: FONT_SANS,
        fontWeight: 700, fontSize: 15,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        border: "1px solid var(--c-line)",
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        letterSpacing: -0.1,
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── TabBar ─────────────────────────────────────────────────────────────────

export type TabItem<T extends string = string> = {
  id: T;
  label: string;
  icon: ReactNode;
  badge?: boolean;
};

export function TabBar<T extends string>({
  tabs, active, onChange,
}: { tabs: TabItem<T>[]; active: T; onChange: (id: T) => void }) {
  return (
    <nav
      style={{
        position: "sticky", bottom: 0, left: 0, right: 0,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid var(--c-line-2)",
        display: "flex",
        paddingBottom: 22,
        zIndex: 30,
      }}
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              flex: 1, border: "none", background: "transparent", cursor: "pointer",
              padding: "12px 0 8px",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              position: "relative",
              fontFamily: FONT_SANS,
            }}
          >
            {isActive && (
              <span
                style={{
                  position: "absolute", top: 0, width: 22, height: 3,
                  background: "var(--c-navy)", borderRadius: "0 0 3px 3px",
                }}
              />
            )}
            <span
              style={{
                color: isActive ? "var(--c-navy)" : "var(--c-mute)",
                position: "relative", display: "inline-flex",
              }}
            >
              {t.icon}
              {t.badge && (
                <span
                  style={{
                    position: "absolute", top: -2, right: -4, width: 7, height: 7,
                    borderRadius: "50%", background: "var(--c-coral)",
                    border: "1.5px solid #fff",
                  }}
                />
              )}
            </span>
            <span
              style={{
                fontSize: 11, fontWeight: isActive ? 700 : 600,
                color: isActive ? "var(--c-navy)" : "var(--c-mute)",
                letterSpacing: 0.2,
              }}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
