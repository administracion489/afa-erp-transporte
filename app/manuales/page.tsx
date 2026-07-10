"use client";

const MANUALES = [
  {
    href: "/manuales/conductor",
    tag: "App Conductor",
    accent: "#B4790E",
    accentTint: "#FBEED2",
    title: "Manual App Conductor",
    desc: "Cómo ingresar, conectarte, iniciar tu recorrido y embarcar pasajeros con el QR.",
  },
  {
    href: "/manuales/pasajero",
    tag: "App Pasajero",
    accent: "#12876F",
    accentTint: "#DCF3EE",
    title: "Manual App Pasajero",
    desc: "Cómo ver tu bus en vivo, elegir tu paradero, tu pase de embarque y tu perfil.",
  },
  {
    href: "/manuales/portal-cliente",
    tag: "Portal Cliente",
    accent: "#2563eb",
    accentTint: "#E4ECFD",
    title: "Manual Portal Cliente",
    desc: "Para la empresa que contrata el servicio: dashboard, GPS en vivo, historial y facturación.",
  },
];

export default function ManualesHub() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#FAF8F2",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        color: "#0E1320",
      }}
    >
      <header
        style={{
          background: "linear-gradient(160deg, #0b315f 0%, #071f3d 100%)",
          color: "#fff",
          padding: "40px 20px 34px",
        }}
      >
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>
            AFA <span style={{ fontWeight: 600 }}>Transportes</span>
          </div>
          <h1
            style={{
              fontSize: "clamp(26px,4vw,36px)",
              fontWeight: 800,
              margin: "14px 0 6px",
              color: "#fff",
            }}
          >
            Centro de ayuda
          </h1>
          <p style={{ margin: 0, color: "rgba(255,255,255,.8)", fontSize: 16, maxWidth: "56ch" }}>
            Manuales de uso de nuestras apps y portales, con capturas reales.
          </p>
        </div>
      </header>

      <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px 80px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 18,
          }}
        >
          {MANUALES.map((m) => (
            <a
              key={m.href}
              href={m.href}
              style={{
                display: "block",
                background: "#fff",
                border: "1px solid #E7E5DD",
                borderRadius: 16,
                padding: "22px 22px 24px",
                textDecoration: "none",
                color: "#0E1320",
                boxShadow: "0 8px 24px rgba(11,49,95,.06)",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  fontSize: 11.5,
                  fontWeight: 700,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: m.accent,
                  background: m.accentTint,
                  padding: "4px 10px",
                  borderRadius: 99,
                }}
              >
                {m.tag}
              </span>
              <h2 style={{ fontSize: 19, fontWeight: 800, margin: "12px 0 6px" }}>{m.title}</h2>
              <p style={{ margin: "0 0 14px", fontSize: 14, color: "#6B7280", lineHeight: 1.5 }}>{m.desc}</p>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: m.accent }}>Abrir manual →</span>
            </a>
          ))}
        </div>
      </main>
    </div>
  );
}
