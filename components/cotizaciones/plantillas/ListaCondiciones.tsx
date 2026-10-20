"use client";
// components/cotizaciones/plantillas/ListaCondiciones.tsx — Una lista editable de condiciones
// (Incluye, No incluye, Consideraciones generales) de una plantilla. Vive FUERA de la página a
// propósito: definida dentro del render, cada tecla la volvía a montar y el campo perdía el foco.

export function ListaCondiciones({ titulo, color, items, onChange, avisoLinea, vacia }: {
  titulo: string;
  color: string;
  items: string[];
  onChange: (items: string[]) => void;
  /** El aviso de una línea (las que la IA manda sin revisión), o null. */
  avisoLinea?: (linea: string) => string | null;
  /** Lo que significa la lista vacía para el PDF. */
  vacia: string;
}) {
  const cambiar = (i: number, v: string) => onChange(items.map((x, j) => (j === i ? v : x)));
  const quitar = (i: number) => onChange(items.filter((_, j) => j !== i));
  const mover = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const n = [...items];
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  const btn: React.CSSProperties = { padding: "0 9px", minHeight: 34, borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#475569", cursor: "pointer", fontWeight: 800, fontSize: 12 };
  return (
    <div>
      <p style={{ fontWeight: 800, fontSize: 12, color, textTransform: "uppercase", margin: "0 0 8px" }}>{titulo}</p>
      {items.length === 0 && <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 6px" }}>{vacia}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item, i) => {
          const aviso = avisoLinea ? avisoLinea(item) : null;
          return (
            <div key={i}>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={item}
                  onChange={e => cambiar(i, e.target.value)}
                  maxLength={500}
                  aria-label={`${titulo}, línea ${i + 1}`}
                  style={{ flex: 1, minWidth: 0, border: `1px solid ${aviso ? "#f59e0b" : "#e2e8f0"}`, borderRadius: 10, padding: "8px 12px", fontSize: 12, outline: "none", background: "white" }}
                />
                <button type="button" onClick={() => mover(i, -1)} disabled={i === 0} title="Subir" style={{ ...btn, opacity: i === 0 ? 0.4 : 1 }}>↑</button>
                <button type="button" onClick={() => mover(i, 1)} disabled={i === items.length - 1} title="Bajar" style={{ ...btn, opacity: i === items.length - 1 ? 0.4 : 1 }}>↓</button>
                <button type="button" onClick={() => quitar(i)} title="Quitar esta línea" style={{ ...btn, border: "1px solid #fca5a5", background: "#fff5f5", color: "#dc2626" }}>✕</button>
              </div>
              {aviso && <p style={{ fontSize: 11, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "4px 8px", margin: "4px 0 0" }}>⚠ {aviso}</p>}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => onChange([...items, ""])} style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color, background: "none", border: "none", cursor: "pointer", padding: "6px 0" }}>+ Agregar línea</button>
    </div>
  );
}
