"use client";
// components/cotizaciones/plantillas/ListaCondiciones.tsx — Una lista editable de condiciones
// (Incluye, No incluye, Consideraciones generales) de una plantilla. Vive FUERA de la página a
// propósito: definida dentro del render, cada tecla la volvía a montar y el campo perdía el foco.
// Topes (lib/cotizacion-plantillas.ts): hasta MAX_LINEAS_CONDICIONES líneas y MAX_CARACTERES_CONDICION
// caracteres por línea; una cotización de traslado que los pasa no la envía sola la IA.

import { MAX_CARACTERES_CONDICION, MAX_LINEAS_CONDICIONES } from "@/lib/cotizacion-plantillas";

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
                  maxLength={MAX_CARACTERES_CONDICION}
                  aria-label={`${titulo}, línea ${i + 1}`}
                  style={{ flex: 1, minWidth: 0, border: `1px solid ${aviso ? "#f59e0b" : "#e2e8f0"}`, borderRadius: 10, padding: "8px 12px", fontSize: 12, outline: "none", background: "white" }}
                />
                <button type="button" onClick={() => mover(i, -1)} disabled={i === 0} title="Subir" style={{ ...btn, opacity: i === 0 ? 0.4 : 1 }}>↑</button>
                <button type="button" onClick={() => mover(i, 1)} disabled={i === items.length - 1} title="Bajar" style={{ ...btn, opacity: i === items.length - 1 ? 0.4 : 1 }}>↓</button>
                <button type="button" onClick={() => quitar(i)} title="Quitar esta línea" style={{ ...btn, border: "1px solid #fca5a5", background: "#fff5f5", color: "#dc2626" }}>✕</button>
              </div>
              {aviso && <p style={{ fontSize: 11, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "4px 8px", margin: "4px 0 0" }}>⚠ {aviso}</p>}
              {Array.from(item).length > MAX_CARACTERES_CONDICION && (
                <p style={{ fontSize: 11, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "4px 8px", margin: "4px 0 0" }}>
                  ⚠ Esta línea pasa de {MAX_CARACTERES_CONDICION} caracteres ({Array.from(item).length}): acórtala; así, la IA no envía sola sus cotizaciones de traslado.
                </p>
              )}
            </div>
          );
        })}
      </div>
      {(() => {
        const lleno = items.length >= MAX_LINEAS_CONDICIONES;
        const porQue = `Hasta ${MAX_LINEAS_CONDICIONES} líneas por lista: más no caben en una hoja del PDF que manda la IA.`;
        return (
          <>
            <button type="button" onClick={() => { if (!lleno) onChange([...items, ""]); }} disabled={lleno} title={lleno ? porQue : undefined}
              style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: lleno ? "#94a3b8" : color, background: "none", border: "none", cursor: lleno ? "not-allowed" : "pointer", padding: "6px 0" }}>+ Agregar línea</button>
            {lleno && (
              <p style={{ fontSize: 11, color: items.length > MAX_LINEAS_CONDICIONES ? "#92400e" : "#64748b", margin: "2px 0 0" }}>
                {items.length > MAX_LINEAS_CONDICIONES
                  ? `⚠ Esta lista tiene ${items.length} líneas: ${porQue} Quita ${items.length - MAX_LINEAS_CONDICIONES}; con más, la IA no envía sola sus cotizaciones de traslado.`
                  : porQue}
              </p>
            )}
          </>
        );
      })()}
    </div>
  );
}
