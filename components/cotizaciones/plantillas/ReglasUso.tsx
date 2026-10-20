"use client";
// components/cotizaciones/plantillas/ReglasUso.tsx — «¿Qué plantilla usa cada cotización?»: una
// celda por tipo de servicio × tipo de cliente (supabase/cotizaciones-05, `cotizacion_plantilla_reglas`).
// Qué plantilla RESULTA de cada celda no lo decide esta pantalla: lo dice `plantillaParaUso`
// (lib/cotizacion-plantillas.ts), el mismo motor que usan /cotizaciones y la IA. Aquí solo se escribe
// la celda —pidiendo la fila de vuelta: con RLS, sin el módulo, la escritura vuelve vacía— y se
// enseña el resultado, en ámbar cuando la regla escrita no es la que se usa.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  DESCRIPCION_SEGMENTO, DESCRIPCION_SERVICIO, ETIQUETA_DISENO, ETIQUETA_SEGMENTO, ETIQUETA_SERVICIO,
  SEGMENTOS, SERVICIOS_PLANTILLA, TABLA_REGLAS, disenoDe, esActiva, etiquetaCelda, plantillaParaUso,
  plantillaPorId, plantillaPrincipal, sirveParaIA,
  type PlantillaFila, type ReglaPlantilla, type Segmento, type ServicioPlantilla,
} from "@/lib/cotizacion-plantillas";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import { SIN_PERMISO_COTIZACIONES, filasDeVuelta, lineasConfirmTraslado } from "./pantalla";

const clave = (s: ServicioPlantilla, g: Segmento) => `${s}|${g}`;
const nombre = (p: PlantillaFila) => `«${p.nombre || p.id}»`;

export function ReglasUso({ plantillas, reglas, onCambio, aviso, perfil }: {
  plantillas: PlantillaFila[];
  reglas: ReglaPlantilla[];
  /** El perfil de la empresa (sus cuentas); undefined mientras carga o si no se pudo leer. */
  perfil?: PerfilEmpresa | null;
  /** Vuelve a leer plantillas y reglas. */
  onCambio: () => Promise<void>;
  aviso: (msg: string, ok?: boolean) => void;
}) {
  const [guardando, setGuardando] = useState<string | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const principal = plantillaPrincipal(plantillas);

  const guardar = async (servicio: ServicioPlantilla, segmento: Segmento, nuevo: string) => {
    const k = clave(servicio, segmento);
    const actual = reglas.find(r => r.servicio === servicio && r.segmento === segmento)?.plantilla_id ?? "";
    if (nuevo === actual || guardando) return;
    const celdaTxt = etiquetaCelda({ servicio, segmento });
    if (servicio === "traslado_ia") {
      // Lo que va a pasar, con el mismo motor: la celda nueva puede terminar en la principal o en nada.
      const otras = reglas.filter(r => !(r.servicio === servicio && r.segmento === segmento));
      const sim = plantillaParaUso({ servicio, segmento }, plantillas, nuevo ? [...otras, { servicio, segmento, plantilla_id: nuevo }] : otras);
      const destino = sim.plantilla ? `las condiciones y las cuentas de la plantilla ${nombre(sim.plantilla)}` : "las condiciones de /tarifario → Ajustes de traslados (no queda una plantilla que la IA pueda usar)";
      // Y lo que de verdad va a salir: las cuentas que imprimirá el PDF y las líneas que conviene mirar.
      const detalle = lineasConfirmTraslado({ resultante: sim.plantilla, plantillas, perfil, segmento });
      if (!window.confirm(`Los traslados que cotiza la IA para clientes «${ETIQUETA_SEGMENTO[segmento]}» salen por WhatsApp SIN revisión.\n\nDesde ahora llevarán ${destino}.${detalle.length ? `\n\n• ${detalle.join("\n• ")}` : ""}\n\n¿Cambiar la regla ${celdaTxt}?`)) return;
    }
    setGuardando(k);
    setErrores(e => { const n = { ...e }; delete n[k]; return n; });
    try {
      const que = `La regla ${celdaTxt}`;
      if (!nuevo) {
        const r = filasDeVuelta<{ servicio: string }>(
          await supabase.from(TABLA_REGLAS).delete().eq("servicio", servicio).eq("segmento", segmento).select("servicio"), que);
        if (!r.ok) {
          // Cero filas: o falta el permiso, o otra persona ya la había quitado. Se mira cuál fue.
          let sigue = true;
          if (r.cero) {
            const { data, error } = await supabase.from(TABLA_REGLAS).select("servicio").eq("servicio", servicio).eq("segmento", segmento).limit(1);
            sigue = !!error || (data ?? []).length > 0;
          }
          if (sigue) { setErrores(e => ({ ...e, [k]: r.cero ? `No se quitó porque ${SIN_PERMISO_COTIZACIONES}.` : r.detalle })); return; }
        }
        await onCambio();
        aviso(`${celdaTxt}: sin regla, usa la plantilla principal.`);
      } else {
        const r = filasDeVuelta<ReglaPlantilla>(
          await supabase.from(TABLA_REGLAS)
            .upsert({ servicio, segmento, plantilla_id: nuevo }, { onConflict: "servicio,segmento" })
            .select("servicio, segmento, plantilla_id"),
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
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 8, width: "100%", minWidth: 720 }}>
        <thead>
          <tr>
            <th style={{ width: 170 }} />
            {SEGMENTOS.map(g => (
              <th key={g} style={{ textAlign: "left", verticalAlign: "bottom", padding: "0 4px" }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "#1e293b" }}>{ETIQUETA_SEGMENTO[g]}</p>
                <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 500, color: "#64748b" }}>{DESCRIPCION_SEGMENTO[g]}</p>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SERVICIOS_PLANTILLA.map(s => {
            const opciones = plantillas.filter(p => esActiva(p) && (s !== "traslado_ia" || sirveParaIA(p)));
            return (
              <tr key={s}>
                <td style={{ verticalAlign: "top", padding: "6px 4px" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "#1e293b" }}>{ETIQUETA_SERVICIO[s]}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>{DESCRIPCION_SERVICIO[s]}</p>
                  {s === "traslado_ia" && (
                    <p style={{ margin: "4px 0 0", fontSize: 11, color: "#475569" }}>La IA solo dibuja el diseño Corporativo y en castellano: solo se ofrecen esas.</p>
                  )}
                </td>
                {SEGMENTOS.map(g => {
                  const k = clave(s, g);
                  const regla = reglas.find(r => r.servicio === s && r.segmento === g);
                  const valor = regla?.plantilla_id ?? "";
                  const apuntada = valor ? plantillaPorId(plantillas, valor) : null;
                  const fueraDeLista = !!valor && !opciones.some(p => p.id === valor);
                  const uso = plantillaParaUso({ servicio: s, segmento: g }, plantillas, reglas);
                  const ambar = uso.codigo === "regla_inactiva" || uso.codigo === "regla_no_sirve_ia" || uso.codigo === "sin_plantilla";
                  return (
                    <td key={g} style={{ verticalAlign: "top", background: "#f8fafc", border: `1px solid ${ambar ? "#fcd34d" : "#e2e8f0"}`, borderRadius: 12, padding: 10 }}>
                      <select
                        value={valor}
                        disabled={guardando != null}
                        onChange={e => guardar(s, g, e.target.value)}
                        aria-label={`Plantilla para ${etiquetaCelda({ servicio: s, segmento: g })}`}
                        style={{ width: "100%", minHeight: 38, border: "1px solid #e2e8f0", borderRadius: 10, padding: "6px 8px", fontSize: 12, background: "white", cursor: guardando ? "wait" : "pointer" }}
                      >
                        <option value="">— principal ({principal ? principal.nombre || principal.id : "no hay principal activa"}) —</option>
                        {opciones.map(p => (
                          <option key={p.id} value={p.id}>{p.icono ? `${p.icono} ` : ""}{p.nombre || p.id} · {ETIQUETA_DISENO[disenoDe(p)]}</option>
                        ))}
                        {fueraDeLista && (
                          <option value={valor}>
                            ⚠ {apuntada ? apuntada.nombre || apuntada.id : valor} ({!apuntada ? "ya no existe" : !esActiva(apuntada) ? "desactivada" : "la IA no la dibuja"})
                          </option>
                        )}
                      </select>
                      {guardando === k ? (
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#475569" }}>Guardando…</p>
                      ) : ambar ? (
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#92400e", background: "#fffbeb", borderRadius: 8, padding: "4px 6px" }}>⚠ {uso.detalle}</p>
                      ) : (
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#64748b" }}>
                          {uso.plantilla ? <>Usa {nombre(uso.plantilla)}{uso.codigo === "principal" ? " (la principal)" : " (por esta regla)"}</> : uso.detalle}
                        </p>
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
  );
}
