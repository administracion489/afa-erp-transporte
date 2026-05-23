"use client";
import { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";

type EmpresaPerfil = {
  id: number;
  nombre: string | null;
  razon_social: string | null;
  ruc: string | null;
  direccion: string | null;
  telefono: string | null;
  email: string | null;
  web: string | null;
  slogan: string | null;
  logo_url: string | null;
  logo_claro_url: string | null;
  color_primario: string | null;
  regimen_tributario: string | null;
  moneda: string | null;
  zona_horaria: string | null;
  updated_at: string | null;
};

const REGIMENES = ["General", "RMT", "RER", "RUS"];
const MONEDAS = [
  { value: "PEN", label: "PEN — Sol Peruano (S/)" },
  { value: "USD", label: "USD — Dólar Americano ($)" },
];
const ZONAS = [
  "America/Lima",
  "America/Bogota",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Mexico_City",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

const PERFIL_VACIO: EmpresaPerfil = {
  id: 1,
  nombre: "",
  razon_social: "",
  ruc: "",
  direccion: "",
  telefono: "",
  email: "",
  web: "",
  slogan: "",
  logo_url: null,
  logo_claro_url: null,
  color_primario: "#0b315f",
  regimen_tributario: "General",
  moneda: "PEN",
  zona_horaria: "America/Lima",
  updated_at: null,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "10px 14px",
  fontSize: 14,
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
  transition: "border-color 0.15s",
  background: "white",
};

function CampoForm({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "#6b7280",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
      {error && (
        <p style={{ fontSize: 11, color: "#ef4444", marginTop: 5, fontWeight: 600 }}>
          {error}
        </p>
      )}
      {!error && hint && (
        <p style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>{hint}</p>
      )}
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "white",
        borderRadius: 20,
        border: "1px solid #e5e7eb",
        padding: "24px 28px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <h2
        style={{
          fontSize: 12,
          fontWeight: 800,
          color: "#0b315f",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          marginBottom: 20,
          marginTop: 0,
        }}
      >
        {titulo}
      </h2>
      {children}
    </div>
  );
}

function UploadLogo({
  url,
  subiendo,
  etiqueta,
  descripcion,
  oscuro,
  inputRef,
  onFile,
}: {
  url: string | null;
  subiendo: boolean;
  etiqueta: string;
  descripcion: string;
  oscuro?: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div
      style={{
        background: "white",
        borderRadius: 20,
        border: "1px solid #e5e7eb",
        padding: 24,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <h3
        style={{
          fontSize: 12,
          fontWeight: 800,
          color: "#0b315f",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          marginBottom: 4,
          marginTop: 0,
        }}
      >
        {etiqueta}
      </h3>
      <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 14, marginTop: 0 }}>
        {descripcion}
      </p>

      <div
        style={{
          width: "100%",
          height: 140,
          borderRadius: 14,
          border: `2px dashed ${oscuro ? "#374151" : "#e5e7eb"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: oscuro
            ? "linear-gradient(135deg, #0c2d52 0%, #091f3a 100%)"
            : "#f9fafb",
          marginBottom: 12,
          overflow: "hidden",
        }}
      >
        {url ? (
          <img
            src={url}
            alt={etiqueta}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", padding: 12 }}
          />
        ) : (
          <div style={{ textAlign: "center", color: oscuro ? "rgba(255,255,255,0.25)" : "#d1d5db" }}>
            <div style={{ fontSize: 36, marginBottom: 6 }}>{oscuro ? "🌙" : "🏢"}</div>
            <p style={{ fontSize: 11, fontWeight: 600, margin: 0 }}>Sin logo</p>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onFile}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={subiendo}
        style={{
          width: "100%",
          padding: "10px 16px",
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          background: subiendo ? "#f3f4f6" : "white",
          cursor: subiendo ? "wait" : "pointer",
          fontSize: 13,
          fontWeight: 700,
          color: subiendo ? "#9ca3af" : "#374151",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {subiendo ? (
          <>
            <span
              style={{
                display: "inline-block",
                width: 14,
                height: 14,
                border: "2px solid #d1d5db",
                borderTopColor: "#0b315f",
                borderRadius: "50%",
                animation: "spin 0.7s linear infinite",
              }}
            />
            Subiendo...
          </>
        ) : (
          <>📤 {url ? "Cambiar imagen" : "Subir imagen"}</>
        )}
      </button>
      <p style={{ fontSize: 10, color: "#9ca3af", marginTop: 8, textAlign: "center" }}>
        PNG, JPG, SVG · máx. 5 MB
      </p>
    </div>
  );
}

// ── SQL de inicialización (solo visible con contraseña de vendedor) ──────────
const SQL_INIT = `-- 1. Tabla empresa_perfil
CREATE TABLE IF NOT EXISTS empresa_perfil (
  id                 INT PRIMARY KEY DEFAULT 1,
  nombre             TEXT,
  razon_social       TEXT,
  ruc                TEXT,
  direccion          TEXT,
  telefono           TEXT,
  email              TEXT,
  web                TEXT,
  slogan             TEXT,
  logo_url           TEXT,
  logo_claro_url     TEXT,
  color_primario     TEXT DEFAULT '#0b315f',
  regimen_tributario TEXT DEFAULT 'General',
  moneda             TEXT DEFAULT 'PEN',
  zona_horaria       TEXT DEFAULT 'America/Lima',
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO empresa_perfil (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 2. Bucket de storage
INSERT INTO storage.buckets (id, name, public)
VALUES ('empresa', 'empresa', true)
ON CONFLICT (id) DO NOTHING;

-- 3. Políticas de acceso al bucket
CREATE POLICY "Lectura pública empresa"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'empresa');

CREATE POLICY "Subida autenticada empresa"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'empresa');

CREATE POLICY "Actualización autenticada empresa"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'empresa');`;

export default function PerfilEmpresaPage() {
  const [perfil, setPerfil] = useState<EmpresaPerfil>(PERFIL_VACIO);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [subiendoLogo, setSubiendoLogo] = useState(false);
  const [subiendoLogoClaro, setSubiendoLogoClaro] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tipo: "ok" | "error" }>({
    msg: "",
    tipo: "ok",
  });
  const [errorRuc, setErrorRuc] = useState("");
  const [modalSql, setModalSql] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [sqlOk, setSqlOk] = useState(false);
  const [copiado, setCopiado] = useState(false);

  const inputLogoRef = useRef<HTMLInputElement | null>(null);
  const inputLogoClaroRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    cargar();
  }, []);

  async function cargar() {
    setCargando(true);
    const { data, error } = await supabase
      .from("empresa_perfil")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      mostrarToast("Error al cargar datos: " + error.message, "error");
    } else if (data) {
      setPerfil({ ...PERFIL_VACIO, ...data });
    }
    setCargando(false);
  }

  function mostrarToast(msg: string, tipo: "ok" | "error" = "ok") {
    setToast({ msg, tipo });
    setTimeout(() => setToast({ msg: "", tipo: "ok" }), 4500);
  }

  function campo(k: keyof EmpresaPerfil) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const v = e.target.value;
      setPerfil((p) => ({ ...p, [k]: v }));
      if (k === "ruc") {
        setErrorRuc(v && !/^\d{11}$/.test(v) ? "El RUC debe tener exactamente 11 dígitos" : "");
      }
    };
  }

  async function subirImagen(file: File, path: string): Promise<string> {
    const { error } = await supabase.storage
      .from("empresa")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from("empresa").getPublicUrl(path);
    return data.publicUrl + "?t=" + Date.now();
  }

  async function manejarSubida(
    e: React.ChangeEvent<HTMLInputElement>,
    tipo: "principal" | "claro"
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      mostrarToast("Solo se permiten imágenes (PNG, JPG, SVG)", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      mostrarToast("La imagen no puede superar 5 MB", "error");
      return;
    }

    const setter = tipo === "principal" ? setSubiendoLogo : setSubiendoLogoClaro;
    setter(true);
    try {
      const path = tipo === "principal" ? "logo.png" : "logo-claro.png";
      const urlConCache = await subirImagen(file, path);
      const urlBase = urlConCache.split("?")[0];
      const campo = tipo === "principal" ? "logo_url" : "logo_claro_url";

      await supabase
        .from("empresa_perfil")
        .update({ [campo]: urlBase, updated_at: new Date().toISOString() })
        .eq("id", 1);

      setPerfil((p) => ({ ...p, [campo]: urlConCache }));
      mostrarToast(
        tipo === "principal" ? "Logo principal actualizado" : "Logo versión clara actualizado"
      );
    } catch (err: any) {
      mostrarToast("Error al subir imagen: " + err.message, "error");
    } finally {
      setter(false);
      e.target.value = "";
    }
  }

  async function guardar() {
    if (errorRuc) {
      mostrarToast("Corrige el RUC antes de guardar", "error");
      return;
    }
    setGuardando(true);
    const { error } = await supabase.from("empresa_perfil").upsert(
      {
        id: 1,
        nombre: perfil.nombre || null,
        razon_social: perfil.razon_social || null,
        ruc: perfil.ruc || null,
        direccion: perfil.direccion || null,
        telefono: perfil.telefono || null,
        email: perfil.email || null,
        web: perfil.web || null,
        slogan: perfil.slogan || null,
        color_primario: perfil.color_primario || "#0b315f",
        regimen_tributario: perfil.regimen_tributario || "General",
        moneda: perfil.moneda || "PEN",
        zona_horaria: perfil.zona_horaria || "America/Lima",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
    setGuardando(false);
    if (error) {
      mostrarToast("Error al guardar: " + error.message, "error");
    } else {
      mostrarToast("Cambios guardados correctamente");
      cargar();
    }
  }

  if (cargando) {
    return (
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 40,
              height: 40,
              border: "4px solid #e5e7eb",
              borderTopColor: "#0b315f",
              borderRadius: "50%",
              margin: "0 auto 12px",
              animation: "spin 0.8s linear infinite",
            }}
          />
          <p style={{ color: "#0b315f", fontWeight: 700, fontSize: 14 }}>Cargando perfil...</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Toast */}
      {toast.msg && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            padding: "13px 22px",
            borderRadius: 14,
            fontWeight: 700,
            fontSize: 14,
            background: toast.tipo === "ok" ? "#dcfce7" : "#fee2e2",
            border: `1px solid ${toast.tipo === "ok" ? "#86efac" : "#fca5a5"}`,
            color: toast.tipo === "ok" ? "#15803d" : "#dc2626",
            boxShadow: "0 6px 24px rgba(0,0,0,0.13)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>{toast.tipo === "ok" ? "✓" : "✕"}</span>
          {toast.msg}
        </div>
      )}

      {/* Cabecera */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: "#111827", margin: 0 }}>
          Perfil de la Empresa
        </h1>
        <p style={{ fontSize: 13, color: "#9ca3af", marginTop: 6, margin: "6px 0 0" }}>
          Datos · Logo · Configuración regional — Se usan en PDFs, cotizaciones y reportes
        </p>
      </div>

      {/* Layout dos columnas */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 330px",
          gap: 24,
          alignItems: "start",
        }}
      >
        {/* ── Columna izquierda ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Información principal */}
          <Seccion titulo="Información Principal">
            <CampoForm label="Nombre de la empresa">
              <input
                style={inputStyle}
                placeholder="AFA Transportes"
                value={perfil.nombre || ""}
                onChange={campo("nombre")}
                onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
              />
            </CampoForm>

            <CampoForm label="Razón social" hint="Tal como aparece en SUNAT">
              <input
                style={inputStyle}
                placeholder="AFA TOURS S.A.C."
                value={perfil.razon_social || ""}
                onChange={campo("razon_social")}
                onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
              />
            </CampoForm>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <CampoForm
                label="RUC"
                hint={!errorRuc ? "11 dígitos — número de SUNAT" : undefined}
                error={errorRuc}
              >
                <input
                  style={{
                    ...inputStyle,
                    fontFamily: "monospace",
                    borderColor: errorRuc ? "#ef4444" : "#e5e7eb",
                    letterSpacing: "0.05em",
                  }}
                  placeholder="20123456789"
                  maxLength={11}
                  value={perfil.ruc || ""}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "");
                    setPerfil((p) => ({ ...p, ruc: v }));
                    setErrorRuc(
                      v && !/^\d{11}$/.test(v) ? "El RUC debe tener exactamente 11 dígitos" : ""
                    );
                  }}
                  onFocus={(e) => {
                    if (!errorRuc) e.target.style.borderColor = "#0b315f";
                  }}
                  onBlur={(e) => {
                    if (!errorRuc) e.target.style.borderColor = "#e5e7eb";
                  }}
                />
              </CampoForm>

              <CampoForm label="Régimen tributario">
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={perfil.regimen_tributario || "General"}
                  onChange={campo("regimen_tributario")}
                >
                  {REGIMENES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </CampoForm>
            </div>
          </Seccion>

          {/* Contacto */}
          <Seccion titulo="Contacto y Presencia">
            <CampoForm label="Dirección">
              <input
                style={inputStyle}
                placeholder="Av. El Sol 123, Lima, Perú"
                value={perfil.direccion || ""}
                onChange={campo("direccion")}
                onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
              />
            </CampoForm>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <CampoForm label="Teléfono">
                <input
                  style={inputStyle}
                  placeholder="+51 1 234 5678"
                  value={perfil.telefono || ""}
                  onChange={campo("telefono")}
                  onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                  onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
                />
              </CampoForm>

              <CampoForm label="Email de contacto">
                <input
                  type="email"
                  style={inputStyle}
                  placeholder="contacto@empresa.com"
                  value={perfil.email || ""}
                  onChange={campo("email")}
                  onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                  onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
                />
              </CampoForm>
            </div>

            <CampoForm label="Sitio web">
              <input
                style={inputStyle}
                placeholder="https://www.afatours.com.pe"
                value={perfil.web || ""}
                onChange={campo("web")}
                onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
              />
            </CampoForm>

            <CampoForm label="Slogan" hint="Aparece en cotizaciones y documentos PDF">
              <input
                style={inputStyle}
                placeholder="Transporte seguro y puntual en el Perú"
                value={perfil.slogan || ""}
                onChange={campo("slogan")}
                onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
              />
            </CampoForm>
          </Seccion>

          {/* Configuración regional */}
          <Seccion titulo="Configuración Regional y Visual">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
              <CampoForm label="Moneda por defecto">
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={perfil.moneda || "PEN"}
                  onChange={campo("moneda")}
                >
                  {MONEDAS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </CampoForm>

              <CampoForm label="Zona horaria">
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={perfil.zona_horaria || "America/Lima"}
                  onChange={campo("zona_horaria")}
                >
                  {ZONAS.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </CampoForm>

              <CampoForm label="Color primario" hint="Personaliza reportes y PDFs">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="color"
                    style={{
                      width: 44,
                      height: 44,
                      padding: 3,
                      border: "1px solid #e5e7eb",
                      borderRadius: 10,
                      cursor: "pointer",
                      background: "white",
                      flexShrink: 0,
                    }}
                    value={perfil.color_primario || "#0b315f"}
                    onChange={campo("color_primario")}
                  />
                  <input
                    style={{
                      ...inputStyle,
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                      flex: 1,
                    }}
                    value={perfil.color_primario || "#0b315f"}
                    maxLength={7}
                    onChange={campo("color_primario")}
                    onFocus={(e) => (e.target.style.borderColor = "#0b315f")}
                    onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
                  />
                </div>
                <div
                  style={{
                    marginTop: 8,
                    height: 6,
                    borderRadius: 999,
                    background: perfil.color_primario || "#0b315f",
                    opacity: 0.7,
                  }}
                />
              </CampoForm>
            </div>
          </Seccion>
        </div>

        {/* ── Columna derecha: logos ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <UploadLogo
            url={perfil.logo_url}
            subiendo={subiendoLogo}
            etiqueta="Logo Principal"
            descripcion="Para PDFs, cotizaciones y reportes"
            oscuro={false}
            inputRef={inputLogoRef}
            onFile={(e) => manejarSubida(e, "principal")}
          />

          <UploadLogo
            url={perfil.logo_claro_url}
            subiendo={subiendoLogoClaro}
            etiqueta="Logo Versión Clara"
            descripcion="Para sidebar y fondos oscuros"
            oscuro={true}
            inputRef={inputLogoClaroRef}
            onFile={(e) => manejarSubida(e, "claro")}
          />

          {/* Última actualización */}
          {perfil.updated_at && (
            <div
              style={{
                background: "#f9fafb",
                borderRadius: 14,
                border: "1px solid #f0f0f0",
                padding: "14px 18px",
              }}
            >
              <p style={{ fontSize: 10, color: "#9ca3af", margin: "0 0 4px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Última actualización
              </p>
              <p style={{ fontSize: 12, fontWeight: 700, color: "#374151", margin: 0 }}>
                {new Date(perfil.updated_at).toLocaleString("es-PE", {
                  day: "2-digit",
                  month: "long",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
          )}

          {/* Botón oculto de vendedor */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={() => { setModalSql(true); setPin(""); setPinError(""); setSqlOk(false); }}
              title="Inicialización del sistema"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                opacity: 0.18,
                fontSize: 11,
                color: "#6b7280",
                padding: "6px 10px",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 5,
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.65")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.18")}
            >
              🔧 <span style={{ fontFamily: "monospace" }}>init</span>
            </button>
          </div>
        </div>
      </div>

      {/* Botón guardar */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: 28,
          paddingBottom: 32,
          gap: 12,
          alignItems: "center",
        }}
      >
        {guardando && (
          <span style={{ fontSize: 13, color: "#6b7280" }}>Guardando cambios...</span>
        )}
        <button
          onClick={guardar}
          disabled={guardando || !!errorRuc}
          style={{
            padding: "12px 36px",
            borderRadius: 14,
            border: "none",
            background: guardando ? "#93c5fd" : "#0b315f",
            color: "white",
            fontSize: 15,
            fontWeight: 800,
            cursor: guardando || !!errorRuc ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            boxShadow: "0 4px 16px rgba(11,49,95,0.25)",
            opacity: errorRuc ? 0.6 : 1,
            transition: "all 0.15s",
          }}
        >
          {guardando ? (
            <>
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  height: 16,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "white",
                  borderRadius: "50%",
                  animation: "spin 0.7s linear infinite",
                }}
              />
              Guardando...
            </>
          ) : (
            "Guardar cambios"
          )}
        </button>
      </div>

      {/* ── Modal SQL vendedor ── */}
      {modalSql && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) { setModalSql(false); setSqlOk(false); } }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(4,15,30,0.72)",
            backdropFilter: "blur(4px)",
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              background: "#0f172a",
              borderRadius: 24,
              width: "100%",
              maxWidth: sqlOk ? 720 : 420,
              boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.07)",
              overflow: "hidden",
              transition: "max-width 0.25s ease",
            }}
          >
            {/* Cabecera modal */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "20px 28px",
                borderBottom: "1px solid rgba(255,255,255,0.07)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: "linear-gradient(135deg, #1e3a5f, #0b315f)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 18,
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                >
                  {sqlOk ? "⚙" : "🔐"}
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "white" }}>
                    {sqlOk ? "SQL de Inicialización" : "Acceso Vendedor"}
                  </p>
                  <p style={{ margin: 0, fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                    {sqlOk ? "Supabase → SQL Editor" : "Sección exclusiva del instalador"}
                  </p>
                </div>
              </div>
              <button
                onClick={() => { setModalSql(false); setSqlOk(false); }}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "none",
                  borderRadius: 8,
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  color: "rgba(255,255,255,0.5)",
                  fontSize: 18,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ✕
              </button>
            </div>

            {/* Cuerpo: PIN */}
            {!sqlOk && (
              <div style={{ padding: "32px 28px" }}>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginBottom: 28, marginTop: 0, lineHeight: 1.6 }}>
                  Esta sección contiene los scripts de base de datos y configuración
                  del sistema. Solo el instalador autorizado puede acceder.
                </p>
                <label
                  style={{
                    display: "block",
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "rgba(255,255,255,0.35)",
                    marginBottom: 8,
                  }}
                >
                  Contraseña de vendedor
                </label>
                <div style={{ display: "flex", gap: 10 }}>
                  <input
                    type="password"
                    autoFocus
                    value={pin}
                    onChange={(e) => { setPin(e.target.value); setPinError(""); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (pin === "afaerp.init") { setSqlOk(true); setPinError(""); }
                        else setPinError("Contraseña incorrecta");
                      }
                    }}
                    placeholder="••••••••••"
                    style={{
                      flex: 1,
                      background: "rgba(255,255,255,0.06)",
                      border: `1px solid ${pinError ? "#f87171" : "rgba(255,255,255,0.12)"}`,
                      borderRadius: 12,
                      padding: "12px 16px",
                      fontSize: 14,
                      color: "white",
                      outline: "none",
                      fontFamily: "monospace",
                      letterSpacing: "0.15em",
                    }}
                  />
                  <button
                    onClick={() => {
                      if (pin === "afaerp.init") { setSqlOk(true); setPinError(""); }
                      else setPinError("Contraseña incorrecta");
                    }}
                    style={{
                      padding: "12px 24px",
                      borderRadius: 12,
                      border: "none",
                      background: "#1e5fa8",
                      color: "white",
                      fontWeight: 800,
                      fontSize: 14,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Acceder →
                  </button>
                </div>
                {pinError && (
                  <p style={{ fontSize: 12, color: "#f87171", marginTop: 10, fontWeight: 600 }}>
                    ✕ {pinError}
                  </p>
                )}
              </div>
            )}

            {/* Cuerpo: SQL desbloqueado */}
            {sqlOk && (
              <div style={{ padding: "0 0 24px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 24px",
                    borderBottom: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <p style={{ margin: 0, fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                    Copiar y ejecutar en Supabase → SQL Editor
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(SQL_INIT);
                      setCopiado(true);
                      setTimeout(() => setCopiado(false), 2500);
                    }}
                    style={{
                      padding: "6px 16px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.15)",
                      background: copiado ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.07)",
                      color: copiado ? "#4ade80" : "rgba(255,255,255,0.7)",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      transition: "all 0.2s",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {copiado ? "✓ Copiado" : "📋 Copiar SQL"}
                  </button>
                </div>
                <div style={{ padding: "0 24px", maxHeight: "55vh", overflowY: "auto" }}>
                  <pre
                    style={{
                      fontSize: 12,
                      color: "#7dd3fc",
                      margin: "16px 0 0",
                      lineHeight: 1.75,
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {SQL_INIT}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
