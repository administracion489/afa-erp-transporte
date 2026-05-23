"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type PaginaLegal = {
  id: string;
  titulo: string;
  contenido: string;
  updated_at: string;
  updated_por: string | null;
};

const C = {
  navy: "#0b315f", navyDark: "#07203f",
  white: "#ffffff", gray50: "#f8fafc", gray100: "#f1f5f9",
  gray200: "#e2e8f0", gray400: "#94a3b8", gray600: "#475569", gray800: "#1e293b",
  green: "#16a34a", red: "#dc2626",
};

const iSt: React.CSSProperties = {
  width: "100%", border: `1px solid ${C.gray200}`, borderRadius: 10,
  padding: "9px 12px", fontSize: 13, outline: "none", background: "white",
  fontFamily: "system-ui, sans-serif",
};

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div style={{ position: "fixed", bottom: 28, right: 28, zIndex: 100, background: ok ? C.green : C.red, color: "white", padding: "12px 20px", borderRadius: 14, fontWeight: 700, fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.2)" }}>
      {ok ? "✅" : "❌"} {msg}
    </div>
  );
}

export default function LegalEditorPage() {
  const [pagina,    setPagina]    = useState<PaginaLegal | null>(null);
  const [titulo,    setTitulo]    = useState("");
  const [contenido, setContenido] = useState("");
  const [loading,   setLoading]   = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [preview,   setPreview]   = useState(false);
  const [toast,     setToast]     = useState<{ msg: string; ok: boolean } | null>(null);
  const [sqlModal,  setSqlModal]  = useState(false);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const cargar = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("paginas_legales")
      .select("*")
      .eq("id", "privacidad")
      .maybeSingle();
    if (data) {
      setPagina(data as PaginaLegal);
      setTitulo(data.titulo || "");
      setContenido(data.contenido || "");
    }
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  const guardar = async () => {
    setGuardando(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("paginas_legales").upsert({
      id: "privacidad",
      titulo: titulo.trim() || "Política de Privacidad",
      contenido,
      updated_at: new Date().toISOString(),
      updated_por: user?.email || null,
    }, { onConflict: "id" });
    if (error) showToast(error.message, false);
    else { showToast("Política guardada y publicada"); cargar(); }
    setGuardando(false);
  };

  const SQL_INIT = `-- Tabla para páginas legales editables
CREATE TABLE IF NOT EXISTS paginas_legales (
  id           TEXT PRIMARY KEY,
  titulo       TEXT NOT NULL DEFAULT 'Política de Privacidad',
  contenido    TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_por  TEXT
);

INSERT INTO paginas_legales (id, titulo)
VALUES ('privacidad', 'Política de Privacidad y Protección de Datos Personales')
ON CONFLICT (id) DO NOTHING;`;

  const updStr = pagina?.updated_at
    ? new Date(pagina.updated_at).toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div style={{ padding: "28px 24px", maxWidth: 1100, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      {toast && <Toast msg={toast.msg} ok={toast.ok} />}

      {/* SQL Modal */}
      {sqlModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: "white", borderRadius: 20, width: "100%", maxWidth: 560, padding: 24, boxShadow: "0 24px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <p style={{ fontWeight: 900, fontSize: 15, color: C.gray800, margin: 0 }}>🗄️ SQL de inicialización</p>
              <button onClick={() => setSqlModal(false)} style={{ background: C.gray100, border: "none", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 14, color: C.gray600 }}>✕</button>
            </div>
            <p style={{ color: C.gray600, fontSize: 12, marginBottom: 12 }}>Ejecuta este SQL en Supabase → SQL Editor si la tabla no existe:</p>
            <pre style={{ background: "#1e293b", color: "#e2e8f0", borderRadius: 10, padding: "14px 16px", fontSize: 11, overflow: "auto", margin: "0 0 16px", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {SQL_INIT}
            </pre>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { navigator.clipboard.writeText(SQL_INIT); showToast("SQL copiado"); setSqlModal(false); }}
                style={{ flex: 1, padding: "10px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontWeight: 800, fontSize: 13, cursor: "pointer" }}
              >
                📋 Copiar SQL
              </button>
              <button onClick={() => setSqlModal(false)} style={{ padding: "10px 18px", borderRadius: 10, border: `1px solid ${C.gray200}`, background: "white", color: C.gray600, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: C.gray800, margin: 0 }}>📄 Páginas Legales</h1>
          <p style={{ color: C.gray400, fontSize: 13, margin: "4px 0 0" }}>
            Edita la política de privacidad publicada en{" "}
            <a href="/privacidad" target="_blank" rel="noreferrer" style={{ color: C.navy, fontWeight: 700 }}>
              transportesafa.com/privacidad ↗
            </a>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setSqlModal(true)} style={{ padding: "8px 14px", borderRadius: 10, border: `1px solid ${C.gray200}`, background: C.gray50, color: C.gray600, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            🗄️ SQL
          </button>
          <a href="/privacidad" target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, border: `1px solid ${C.navy}33`, background: "#eef3f8", color: C.navy, fontWeight: 700, fontSize: 12, textDecoration: "none" }}>
            👁 Ver publicada
          </a>
          <button onClick={guardar} disabled={guardando || loading} style={{ padding: "8px 20px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 13, cursor: "pointer", opacity: (guardando || loading) ? 0.6 : 1 }}>
            {guardando ? "Guardando..." : "💾 Guardar y publicar"}
          </button>
        </div>
      </div>

      {/* Estado */}
      {pagina && updStr && (
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block" }} />
          <p style={{ color: "#166534", fontSize: 12, fontWeight: 700, margin: 0 }}>
            Publicada · Última actualización: {updStr}{pagina.updated_por ? ` · por ${pagina.updated_por}` : ""}
          </p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: 60, color: C.gray400 }}>Cargando...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Título */}
          <div style={{ background: "white", borderRadius: 16, padding: "18px 20px", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.gray400, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              Título de la página
            </label>
            <input
              value={titulo}
              onChange={e => setTitulo(e.target.value)}
              style={{ ...iSt, fontSize: 16, fontWeight: 700 }}
              placeholder="Política de Privacidad y Protección de Datos Personales"
            />
          </div>

          {/* Tabs vista / edición */}
          <div style={{ background: "white", borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
            <div style={{ background: C.gray50, borderBottom: `1px solid ${C.gray200}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px" }}>
              <div style={{ display: "flex" }}>
                {[
                  { id: false, label: "✏️ Editor HTML" },
                  { id: true,  label: "👁 Vista previa" },
                ].map(t => (
                  <button key={String(t.id)} onClick={() => setPreview(t.id)}
                    style={{ padding: "12px 18px", border: "none", borderBottom: `3px solid ${preview === t.id ? C.navy : "transparent"}`, background: "none", color: preview === t.id ? C.navy : C.gray600, fontWeight: preview === t.id ? 800 : 600, fontSize: 13, cursor: "pointer" }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: C.gray400, margin: 0 }}>
                HTML estándar: &lt;h2&gt;, &lt;h3&gt;, &lt;p&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;strong&gt;
              </p>
            </div>

            {!preview ? (
              <textarea
                value={contenido}
                onChange={e => setContenido(e.target.value)}
                style={{
                  width: "100%", minHeight: 520, border: "none", outline: "none",
                  padding: "20px", fontSize: 12, fontFamily: "JetBrains Mono, 'Courier New', monospace",
                  lineHeight: 1.7, resize: "vertical", color: C.gray800,
                  boxSizing: "border-box",
                }}
                placeholder="<h2>1. Introducción</h2>&#10;<p>Contenido de la sección...</p>&#10;&#10;<h2>2. Datos recopilados</h2>&#10;<ul>&#10;  <li>Elemento 1</li>&#10;</ul>"
              />
            ) : (
              <div style={{ padding: "24px 28px", minHeight: 520 }}>
                {/* Preview con los mismos estilos que la página pública */}
                <style>{`
                  .prev-content h2{font-size:17px;font-weight:900;color:#0b315f;margin:28px 0 10px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;}
                  .prev-content h3{font-size:14px;font-weight:800;color:#1e293b;margin:16px 0 6px;}
                  .prev-content p{color:#374151;font-size:14px;line-height:1.8;margin:0 0 10px;}
                  .prev-content ul{margin:0 0 12px;padding-left:20px;}
                  .prev-content li{color:#374151;font-size:14px;line-height:1.8;margin-bottom:4px;}
                  .prev-content strong{color:#1e293b;}
                `}</style>
                <p style={{ fontSize: 11, color: C.gray400, background: "#fef9c3", border: "1px solid #fde047", borderRadius: 8, padding: "8px 12px", marginBottom: 20 }}>
                  ℹ️ Vista previa — así se verá en <strong>/privacidad</strong> (sin encabezado ni pie)
                </p>
                <h1 style={{ fontSize: 22, fontWeight: 900, color: C.navy, marginBottom: 24, borderBottom: `3px solid ${C.navy}`, paddingBottom: 12 }}>{titulo}</h1>
                <div className="prev-content" dangerouslySetInnerHTML={{ __html: contenido }} />
              </div>
            )}
          </div>

          {/* Ayuda HTML */}
          <div style={{ background: "#1e293b", borderRadius: 14, padding: "16px 20px" }}>
            <p style={{ color: "#94a3b8", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>📌 Referencia HTML</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
              {[
                { tag: "<h2>Título sección</h2>",    desc: "Títulos principales" },
                { tag: "<h3>Subtítulo</h3>",         desc: "Subtítulos" },
                { tag: "<p>Párrafo de texto</p>",    desc: "Párrafos" },
                { tag: "<ul><li>Item</li></ul>",      desc: "Listas" },
                { tag: "<strong>Negrita</strong>",   desc: "Texto destacado" },
                { tag: "<a href='...'>Link</a>",      desc: "Enlace" },
              ].map(({ tag, desc }) => (
                <div key={desc} style={{ background: "#0f172a", borderRadius: 8, padding: "8px 12px" }}>
                  <p style={{ color: "#7dd3fc", fontFamily: "monospace", fontSize: 11, margin: "0 0 3px" }}>{tag}</p>
                  <p style={{ color: "#64748b", fontSize: 10, margin: 0 }}>{desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Botón guardar abajo también */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <a href="/privacidad" target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 20px", borderRadius: 12, border: `1px solid ${C.gray200}`, background: "white", color: C.gray600, fontWeight: 700, fontSize: 13, textDecoration: "none" }}>
              👁 Ver publicada ↗
            </a>
            <button onClick={guardar} disabled={guardando} style={{ padding: "10px 28px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 14, cursor: "pointer", opacity: guardando ? 0.7 : 1 }}>
              {guardando ? "Guardando..." : "💾 Guardar y publicar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
