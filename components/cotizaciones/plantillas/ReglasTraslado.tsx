"use client";
// components/cotizaciones/plantillas/ReglasTraslado.tsx — «¿Qué plantilla manda la IA en sus
// traslados?»: una celda por idioma en que escribe el cliente × moneda de la cotización
// (supabase/cotizaciones-09, `cotizacion_plantilla_reglas_traslado`). Reemplaza la fila «Traslado de
// la IA» de la cuadrícula por tipo de cliente (ReglasUso), que queda sin uso con esa tabla.
// Qué plantilla RESULTA de cada celda y si el inglés está encendido no lo decide esta pantalla: lo
// dicen `plantillaTrasladoIA` e `inglesDisponible` (lib/cotizacion-plantillas.ts), los mismos que usa
// la IA, a través de `estadosTraslado` (pantalla.ts). Aquí solo se escribe la celda —pidiendo la fila
// de vuelta: con RLS, sin el módulo, la escritura vuelve vacía— y se enseña el resultado.
// EL INGLÉS SE ENCIENDE AQUÍ, CON UN DATO: asignar una plantilla en inglés a una celda de la fila
// Inglés. Por eso el `confirm()` dice si el inglés se enciende o se apaga, y qué cambia en la moneda.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  ETIQUETA_DISENO, TABLA_REGLAS_TRASLADO, disenoDe, etiquetaCeldaTraslado, plantillaPorId, plantillaPrincipal, sirveParaIA,
  type CeldaTraslado, type PlantillaFila, type ReglaTraslado,
} from "@/lib/cotizacion-plantillas";
import type { Idioma } from "@/lib/cotizacion-idioma";
import type { Moneda } from "@/lib/cotizacion-moneda";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import {
  DESCRIPCION_FILA_CASTELLANO, DESCRIPCION_FILA_INGLES, SIN_PERMISO_COTIZACIONES,
  confirmCeldaTraslado, estadosTraslado, filasDeVuelta, lineaInglesTraslado, porQueNoSirveIA, type TonoCelda,
} from "./pantalla";

const FILAS: { idioma: Idioma; titulo: string; descripcion: string }[] = [
  { idioma: "es", titulo: "Castellano", descripcion: DESCRIPCION_FILA_CASTELLANO },
  { idioma: "en", titulo: "Inglés", descripcion: DESCRIPCION_FILA_INGLES },
];
const COLUMNAS: { moneda: Moneda; titulo: string; descripcion: string }[] = [
  { moneda: "PEN", titulo: "Soles", descripcion: "La cotización sale en soles." },
  { moneda: "USD", titulo: "Dólares", descripcion: "La cotización sale en dólares." },
];

const clave = (c: CeldaTraslado) => `${c.idioma}|${c.moneda}`;
const nombre = (p: PlantillaFila) => `«${p.nombre || p.id}»`;

const ESTILO_TONO: Record<TonoCelda, React.CSSProperties> = {
  ok: { color: "#64748b" },
  gris: { color: "#475569", background: "#eef3f8", borderRadius: 8, padding: "4px 6px" },
  ambar: { color: "#92400e", background: "#fffbeb", borderRadius: 8, padding: "4px 6px" },
};

export function ReglasTraslado({ plantillas, reglasTraslado, onCambio, aviso, perfil }: {
  plantillas: PlantillaFila[];
  reglasTraslado: ReglaTraslado[];
  /** El perfil de la empresa (sus cuentas); undefined mientras carga o si no se pudo leer. */
  perfil?: PerfilEmpresa | null;
  /** Vuelve a leer plantillas y reglas. */
  onCambio: () => Promise<void>;
  aviso: (msg: string, ok?: boolean) => void;
}) {
  const [guardando, setGuardando] = useState<string | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const principal = plantillaPrincipal(plantillas);
  const estado = estadosTraslado(plantillas, reglasTraslado);
  const enIngles = plantillas.filter(p => sirveParaIA(p, "en"));
  const linea = lineaInglesTraslado(estado, enIngles.length);

  const guardar = async (celda: CeldaTraslado, nuevo: string) => {
    const k = clave(celda);
    const actual = reglasTraslado.find(r => r.idioma === celda.idioma && r.moneda === celda.moneda)?.plantilla_id ?? "";
    if (nuevo === actual || guardando) return;
    const celdaTxt = etiquetaCeldaTraslado(celda);
    // Lo que va a pasar, con el mismo motor: encender o apagar el inglés, las condiciones y las cuentas.
    if (!window.confirm(confirmCeldaTraslado({ celda, nuevo, plantillas, reglasTraslado, perfil }))) return;
    setGuardando(k);
    setErrores(e => { const n = { ...e }; delete n[k]; return n; });
    try {
      const que = `La regla ${celdaTxt}`;
      if (!nuevo) {
        const r = filasDeVuelta<{ idioma: string }>(
          await supabase.from(TABLA_REGLAS_TRASLADO).delete().eq("idioma", celda.idioma).eq("moneda", celda.moneda).select("idioma"), que);
        if (!r.ok) {
          // Cero filas: o falta el permiso, o otra persona ya la había quitado. Se mira cuál fue.
          let sigue = true;
          if (r.cero) {
            const { data, error } = await supabase.from(TABLA_REGLAS_TRASLADO).select("idioma").eq("idioma", celda.idioma).eq("moneda", celda.moneda).limit(1);
            sigue = !!error || (data ?? []).length > 0;
          }
          if (sigue) { setErrores(e => ({ ...e, [k]: r.cero ? `No se quitó porque ${SIN_PERMISO_COTIZACIONES}.` : r.detalle })); return; }
        }
        await onCambio();
        aviso(`${celdaTxt}: sin regla.`);
      } else {
        const r = filasDeVuelta<ReglaTraslado>(
          await supabase.from(TABLA_REGLAS_TRASLADO)
            .upsert({ idioma: celda.idioma, moneda: celda.moneda, plantilla_id: nuevo }, { onConflict: "idioma,moneda" })
            .select("idioma, moneda, plantilla_id"),
          que);
        if (!r.ok) { setErrores(e => ({ ...e, [k]: r.detalle })); return; }
        await onCambio();
        const p = plantillaPorId(plantillas, nuevo);
        aviso(`${celdaTxt}: usa ${p ? nombre(p) : `«${nuevo}»`}.`);
      }
    } catch (e) {
      setErrores(x => ({ ...x, [k]: `No se guardó: ${(e as { message?: string })?.message || String(e)}` }));
    } finally {
      setGuardando(null);
    }
  };

  return (
    <div>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "#1e293b" }}>Traslado de la IA</p>
      <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>
        El traslado que cotiza la IA del CRM y se envía por WhatsApp. Se elige por el idioma en que escribe el cliente y la moneda de la cotización. La IA solo dibuja el diseño Corporativo: en castellano se ofrecen las corporativas en castellano; en inglés, las corporativas en inglés.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 8, width: "100%", minWidth: 560 }}>
          <thead>
            <tr>
              <th style={{ width: 200 }} />
              {COLUMNAS.map(c => (
                <th key={c.moneda} style={{ textAlign: "left", verticalAlign: "bottom", padding: "0 4px" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "#1e293b" }}>{c.titulo}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 500, color: "#64748b" }}>{c.descripcion}</p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FILAS.map(f => {
              const opciones = plantillas.filter(p => sirveParaIA(p, f.idioma));
              return (
                <tr key={f.idioma}>
                  <td style={{ verticalAlign: "top", padding: "6px 4px" }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "#1e293b" }}>{f.titulo}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>{f.descripcion}</p>
                  </td>
                  {COLUMNAS.map(col => {
                    const celda: CeldaTraslado = { idioma: f.idioma, moneda: col.moneda };
                    const k = clave(celda);
                    const e = estado.celdas.find(x => x.celda.idioma === f.idioma && x.celda.moneda === col.moneda);
                    const valor = e?.regla?.plantilla_id ?? "";
                    const apuntada = valor ? plantillaPorId(plantillas, valor) : null;
                    const fueraDeLista = !!valor && !opciones.some(p => p.id === valor);
                    const tono: TonoCelda = e?.tono ?? "gris";
                    return (
                      <td key={col.moneda} style={{ verticalAlign: "top", background: "#f8fafc", border: `1px solid ${tono === "ambar" ? "#fcd34d" : "#e2e8f0"}`, borderRadius: 12, padding: 10 }}>
                        <select
                          value={valor}
                          disabled={guardando != null}
                          onChange={ev => guardar(celda, ev.target.value)}
                          aria-label={`Plantilla para ${etiquetaCeldaTraslado(celda)}`}
                          style={{ width: "100%", minHeight: 38, border: "1px solid #e2e8f0", borderRadius: 10, padding: "6px 8px", fontSize: 12, background: "white", cursor: guardando ? "wait" : "pointer" }}
                        >
                          <option value="">{f.idioma === "es" ? `— principal (${principal ? principal.nombre || principal.id : "no hay principal activa"}) —` : "— sin regla —"}</option>
                          {opciones.map(p => (
                            <option key={p.id} value={p.id}>{p.icono ? `${p.icono} ` : ""}{p.nombre || p.id} · {ETIQUETA_DISENO[disenoDe(p)]}</option>
                          ))}
                          {fueraDeLista && (
                            <option value={valor}>⚠ {apuntada ? apuntada.nombre || apuntada.id : valor} ({porQueNoSirveIA(apuntada, f.idioma)})</option>
                          )}
                        </select>
                        {guardando === k ? (
                          <p style={{ margin: "6px 0 0", fontSize: 11, color: "#475569" }}>Guardando…</p>
                        ) : (
                          <p style={{ margin: "6px 0 0", fontSize: 11, ...ESTILO_TONO[tono] }}>{tono === "ambar" ? "⚠ " : ""}{e?.texto ?? "—"}</p>
                        )}
                        {errores[k] && <p style={{ margin: "6px 0 0", fontSize: 11, color: "#991b1b", fontWeight: 700 }}>✕ {errores[k]}</p>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ margin: "4px 8px 0", fontSize: 12, ...(linea.tono === "ok" ? { color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 12px" } : { color: "#475569", background: "#eef3f8", border: "1px solid #c7d8ed", borderRadius: 10, padding: "8px 12px" }) }}>
        {linea.tono === "ok" ? "🌐 " : ""}{linea.texto}
      </p>
      <p style={{ margin: "6px 8px 0", fontSize: 11, color: "#64748b" }}>
        Nada se traduce solo: en inglés van las condiciones de la plantilla en inglés tal como se escribieron.
      </p>
    </div>
  );
}
