"use client";

// El tablero de /programacion, en cuatro bloques que contestan cuatro preguntas distintas:
//   1. HOY (operador, jefe de operaciones): ¿qué tengo que atender ahora?
//   2. OPERACIÓN DEL PERIODO (jefe de operaciones, ingeniero de transporte): ¿cumplimos?
//   3. DINERO DEL PERIODO (contador, administración, ventas): ¿cuánto y qué falta cargar?
//   4. CIERRE DEL PERIODO (contador): ¿cuánto falta liquidar, facturar y cobrar?
// Los números los cuenta la base (fn_programacion_tablero) y cada uno se puede pulsar: la
// lista se reduce a esos servicios, con la MISMA marca con que se contaron. No hay «Total»
// histórico: un número que solo crece no le sirve a nadie para decidir.

import React from "react";
import { ESTADOS_ADMIN } from "@/lib/estados";

type ParCierre = [number, number];
export type TableroDatos = {
  desde: string | null; hasta: string | null;
  hoy: number; en_curso: number; atrasados: number; por_asignar: number; sobrecupo: number; sin_cerrar_total: number;
  servicios: number; prestados: number; cancelados: number; sin_cerrar: number; propios: number; tercerizados: number;
  ventas: number; costos: number; margen: number; con_precio: number;
  sin_precio: number; sin_precio_costo: number; precio_en_hermano: number; sin_costo: number;
  cierre: { por_liquidar: ParCierre; liquidada: ParCierre; facturada: ParCierre; cobrada: ParCierre };
  cierre_atrasado: ParCierre;
};

export type MarcaTablero =
  | "hoy" | "en_curso" | "atrasados" | "por_asignar" | "sobrecupo" | "sin_cerrar_total"
  | "servicios" | "prestados" | "cancelados" | "sin_cerrar" | "sin_precio" | "sin_costo"
  | "cierre_atrasado" | "por_liquidar" | "liquidada" | "facturada" | "cobrada";

type Tono = "neutro" | "azul" | "verde" | "ambar" | "rojo";
const TONO: Record<Tono, { color: string; bg: string }> = {
  neutro: { color: "#0b315f", bg: "#eef3f8" },
  azul:   { color: "#1d4ed8", bg: "#dbeafe" },
  verde:  { color: "#166534", bg: "#dcfce7" },
  ambar:  { color: "#92400e", bg: "#fef3c7" },
  rojo:   { color: "#991b1b", bg: "#fee2e2" },
};

const n = (x: unknown) => Number(x || 0);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const soles = (v: number) => (v < 0 ? "−" : "") + "S/ " + Math.abs(v).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fecha = (f: string | null) => (f ? f.slice(8, 10) + "/" + f.slice(5, 7) + "/" + f.slice(0, 4) : null);

function Kpi({ label, valor, sub, tono, activo, onClick, title, dinero }: {
  label: string; valor: React.ReactNode; sub?: React.ReactNode; tono: Tono;
  activo?: boolean; onClick?: () => void; title?: string; dinero?: boolean;
}) {
  const t = TONO[tono];
  const cuerpo = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: t.color + "aa" }}>{label}</p>
      <p className={(dinero ? "text-xl" : "text-2xl") + " font-black mt-0.5 leading-tight tabular-nums whitespace-nowrap"} style={{ color: t.color }}>{valor}</p>
      {sub && <p className="text-[11px] mt-0.5 leading-snug" style={{ color: t.color + "cc" }}>{sub}</p>}
    </>
  );
  const clase = "rounded-xl p-3 border text-left w-full transition-shadow";
  const estilo = { background: t.bg, borderColor: activo ? t.color : t.color + "22", boxShadow: activo ? `0 0 0 2px ${t.color}55` : undefined };
  if (!onClick) return <div className={clase} style={estilo} title={title}>{cuerpo}</div>;
  return (
    <button type="button" onClick={onClick} className={clase + " hover:shadow-md cursor-pointer"} style={estilo}
      title={(title ? title + " · " : "") + (activo ? "Pulsa para quitar el filtro" : "Pulsa para ver estos servicios")}>
      {cuerpo}
    </button>
  );
}

function Bloque({ titulo, detalle, children }: { titulo: string; detalle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border shadow-sm px-4 py-3 space-y-2.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <p className="text-[11px] font-black uppercase tracking-widest text-gray-600">{titulo}</p>
        {detalle && <p className="text-[11px] text-gray-400">{detalle}</p>}
      </div>
      {children}
    </div>
  );
}

export default function TableroProgramacion({ t, hoy, verMontos, marcaActiva, onMarca, periodoPorDefecto, verTodo }: {
  t: TableroDatos; hoy: string; verMontos: boolean; marcaActiva: string | null;
  onMarca: (clave: MarcaTablero, label: string) => void; periodoPorDefecto: boolean; verTodo: boolean;
}) {
  const m = (clave: MarcaTablero, label: string) => ({ activo: marcaActiva === clave, onClick: () => onMarca(clave, label) });
  const periodo = verTodo
    ? "todo el histórico"
    : `${fecha(t.desde) ?? "inicio"} – ${fecha(t.hasta) ?? "sin fin"}${periodoPorDefecto ? " (mes en curso)" : ""}`;
  const servicios = n(t.servicios), cancelados = n(t.cancelados), prestados = n(t.prestados);
  const ventas = n(t.ventas), margen = n(t.margen);
  const ticket = n(t.con_precio) > 0 ? ventas / n(t.con_precio) : 0;
  const atrasoCierre = n(t.cierre_atrasado?.[0]);

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* 1 · HOY */}
        <Bloque titulo="🚦 Hoy" detalle={`${fecha(hoy)} · lo que hay que atender ahora`}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <Kpi label="Servicios hoy" valor={n(t.hoy)} tono="neutro" {...m("hoy", "Servicios de hoy")} />
            <Kpi label="En curso" valor={n(t.en_curso)} tono="azul" {...m("en_curso", "En curso hoy")} />
            <Kpi label="Atrasados" valor={n(t.atrasados)} tono={n(t.atrasados) ? "rojo" : "verde"}
              sub="pasó su hora y no inició" title="Su hora pasó hace más de 10 min y sigue sin iniciar"
              {...m("atrasados", "Atrasados (hoy, sin iniciar)")} />
            <Kpi label="Por asignar" valor={n(t.por_asignar)} tono={n(t.por_asignar) ? "ambar" : "verde"}
              sub="próx. 7 días" title="Sin unidad o sin conductor (tercerizados: sin empresa o sin unidad), de hoy a 7 días"
              {...m("por_asignar", "Por asignar (próx. 7 días)")} />
            <Kpi label="Sobrecupo" valor={n(t.sobrecupo)} tono={n(t.sobrecupo) ? "rojo" : "verde"}
              sub="próx. 7 días" title="Más pasajeros en el manifiesto que asientos en la unidad"
              {...m("sobrecupo", "Sobrecupo (próx. 7 días)")} />
          </div>
        </Bloque>

        {/* 2 · OPERACIÓN DEL PERIODO */}
        <Bloque titulo="📋 Operación del periodo" detalle={periodo}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Kpi label="Servicios" valor={servicios} tono="neutro" sub="sin contar cancelados"
              {...m("servicios", "Servicios del periodo")} />
            <Kpi label="Prestados" valor={prestados} tono="verde" sub={`${pct(prestados, servicios)} % del periodo`}
              {...m("prestados", "Prestados (finalizados) del periodo")} />
            <Kpi label="Cancelados" valor={cancelados} tono={cancelados ? "ambar" : "neutro"}
              sub={`${pct(cancelados, servicios + cancelados)} % de lo programado`}
              {...m("cancelados", "Cancelados del periodo")} />
            <Kpi label="Sin cerrar" valor={n(t.sin_cerrar)} tono={n(t.sin_cerrar) ? "rojo" : "verde"}
              sub="fecha pasada, no finalizados" title="Ya pasó su fecha y nadie lo finalizó ni lo canceló: no entra a la liquidación"
              {...m("sin_cerrar", "Sin cerrar del periodo")} />
          </div>
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-gray-500">
            <span>Flota: <b className="text-gray-700">{n(t.propios)}</b> propios · <b className="text-gray-700">{n(t.tercerizados)}</b> tercerizados
              {servicios > 0 && <> ({pct(n(t.tercerizados), servicios)} % tercerizado)</>}</span>
            {n(t.sin_cerrar_total) > n(t.sin_cerrar) && (
              <button type="button" onClick={() => onMarca("sin_cerrar_total", "Sin cerrar (todas las fechas)")}
                className="px-2 py-0.5 rounded-lg border border-red-200 bg-red-50 text-red-700 font-bold hover:bg-red-100"
                style={marcaActiva === "sin_cerrar_total" ? { boxShadow: "0 0 0 2px #fca5a5" } : undefined}>
                ⚠ {n(t.sin_cerrar_total) - n(t.sin_cerrar)} sin cerrar de fechas anteriores
              </button>
            )}
          </div>
        </Bloque>

        {/* 3 · DINERO DEL PERIODO */}
        {verMontos && (
          <Bloque titulo="💰 Dinero del periodo" detalle={`${periodo} · excluye cancelados`}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Kpi dinero label="Ventas" valor={soles(ventas)} tono="verde"
                sub={ticket > 0 ? `ticket prom. ${soles(ticket)}` : undefined}
                title="Ticket promedio: ventas ÷ servicios con precio de venta" />
              <Kpi dinero label="Costo proveedor" valor={soles(n(t.costos))} tono="neutro" />
              <Kpi dinero label="Margen" valor={soles(margen)} tono={margen < 0 ? "rojo" : "azul"}
                sub={ventas > 0 ? `${pct(margen, ventas)} % de las ventas` : undefined}
                title="Con servicios sin precio de venta, el margen sale más bajo de lo real" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Kpi label="Sin precio de venta" valor={n(t.sin_precio)} tono={n(t.sin_precio) ? "rojo" : "verde"}
                sub={n(t.sin_precio_costo) > 0 ? `con ${soles(n(t.sin_precio_costo))} de costo` : "nada pendiente"}
                title={`No tienen precio y su tramo hermano tampoco. No se cuentan ${n(t.precio_en_hermano)} retornos/idas cuyo precio va en el otro tramo del día.`}
                {...m("sin_precio", "Sin precio de venta")} />
              <Kpi label="Sin costo" valor={n(t.sin_costo)} tono={n(t.sin_costo) ? "ambar" : "verde"} sub="tercerizados"
                title="Tercerizados sin costo de proveedor (ni en su tramo hermano)"
                {...m("sin_costo", "Tercerizados sin costo")} />
            </div>
            {n(t.precio_en_hermano) > 0 && (
              <p className="text-[11px] text-gray-400">
                {n(t.precio_en_hermano)} tramo(s) en S/ 0.00 no se cuentan como «sin precio»: su precio va en el otro tramo del mismo día.
              </p>
            )}
          </Bloque>
        )}

        {/* 4 · CIERRE DEL PERIODO */}
        <Bloque titulo="🧾 Cierre administrativo" detalle={`${periodo} · solo finalizados`}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(["por_liquidar", "liquidada", "facturada", "cobrada"] as const).map(k => {
              const [cant, monto] = t.cierre?.[k] ?? [0, 0];
              const cfg = ESTADOS_ADMIN[k];
              return (
                <button key={k} type="button" onClick={() => onMarca(k, `${cfg.label} (periodo)`)}
                  title={cfg.descripcion + " · Pulsa para ver estos servicios"}
                  className="rounded-xl px-3 py-2.5 bg-white border text-left hover:shadow-md"
                  style={{ borderColor: marcaActiva === k ? cfg.color : cfg.color + "55", boxShadow: marcaActiva === k ? `0 0 0 2px ${cfg.color}55` : undefined }}>
                  <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cfg.color }}>{cfg.label}</p>
                  <p className="text-2xl font-black mt-0.5 leading-tight" style={{ color: cfg.color }}>{n(cant)}</p>
                  {verMontos && <p className="text-[11px]" style={{ color: cfg.color + "cc" }}>{soles(n(monto))}</p>}
                </button>
              );
            })}
          </div>
          {atrasoCierre > 0 && (
            <button type="button" onClick={() => onMarca("cierre_atrasado", "Por liquidar de periodos anteriores")}
              className="text-[11px] px-2 py-1 rounded-lg border border-purple-200 bg-purple-50 text-purple-800 font-bold hover:bg-purple-100"
              style={marcaActiva === "cierre_atrasado" ? { boxShadow: "0 0 0 2px #c4b5fd" } : undefined}>
              ⚠ {atrasoCierre} servicio(s) de periodos anteriores siguen por liquidar
              {verMontos && <> · {soles(n(t.cierre_atrasado?.[1]))}</>}
            </button>
          )}
        </Bloque>
      </div>
    </section>
  );
}
