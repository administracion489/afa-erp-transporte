"use client";

// components/flota/uso/comun.tsx — Lo que comparten las dos pestañas de /uso-flota: la llamada
// a la API con su error traducido, los formatos y los recuadros de aviso.
//
// NADA DE AQUÍ CALCULA UNA MÉTRICA. Los números, los códigos y los textos de cada código salen de
// los motores (lib/flota/uso-flota.ts, lib/flota/servicio-estadistica.ts, lib/flota/km-gps.ts);
// aquí solo se escriben con la forma del ERP. Un `null` es «sin dato» y NUNCA se pinta como 0.

import React from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { FAMILIAS_TANQUE } from "@/lib/combustible-tipos";

// ─── La llamada ───────────────────────────────────────────────────────────────

export type Resultado<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; reintentar: boolean; permiso: boolean; cancelado?: boolean };

/** Lo que falta cuando la API contesta 401/403: se NOMBRA el permiso, no «error 403». */
export const FALTA_PERMISO =
  "Te falta el permiso del módulo Vehículos: el uso de flota y la estadística por servicio lo exigen. Lo da un administrador en Usuarios.";
const SESION_VENCIDA =
  "Tu sesión no es válida o venció: vuelve a ingresar. Esta pantalla además necesita el permiso del módulo Vehículos.";

/**
 * GET a una API del ERP con la sesión. El cuerpo se lee como TEXTO primero: si la plataforma corta
 * por tiempo responde una página HTML, y `r.json()` estallaría con un «Unexpected token '<'» que no
 * le dice nada a nadie.
 */
export async function pedirApi<T>(url: string, signal?: AbortSignal): Promise<Resultado<T>> {
  try {
    const r = await fetch(url, { headers: await cabecerasErp(), signal, cache: "no-store" });
    const cuerpo = await r.text();
    let j: unknown = null;
    try { j = JSON.parse(cuerpo); } catch { /* no era JSON */ }
    const obj = (j && typeof j === "object" ? j : {}) as { error?: unknown; reintentar?: unknown };
    if (r.status === 401) return { ok: false, status: 401, error: SESION_VENCIDA, reintentar: false, permiso: true };
    if (r.status === 403) return { ok: false, status: 403, error: FALTA_PERMISO, reintentar: false, permiso: true };
    if (!r.ok || !j) {
      const msg = typeof obj.error === "string" && obj.error
        ? obj.error
        : r.status === 504 || r.status === 502
          ? "La medición superó el tiempo límite del servidor. Reintenta en unos segundos o acorta el periodo."
          : `No se pudo medir (error ${r.status}).`;
      return { ok: false, status: r.status, error: msg, reintentar: r.status >= 500 || obj.reintentar === true, permiso: false };
    }
    return { ok: true, data: j as T };
  } catch (e) {
    if (signal?.aborted) return { ok: false, status: 0, error: "Cancelado.", reintentar: true, permiso: false, cancelado: true };
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, error: `No se pudo conectar con el servidor (${m}).`, reintentar: true, permiso: false };
  }
}

/** Espera `ms`, o menos si se cancela. */
export function esperar(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });
}

/** Un 503 («hay demasiados cálculos en curso») se reintenta UNA vez sola; si vuelve, decide la persona. */
export async function pedirConReintento<T>(url: string, signal?: AbortSignal): Promise<Resultado<T>> {
  const r = await pedirApi<T>(url, signal);
  if (r.ok || r.status !== 503 || signal?.aborted) return r;
  await esperar(3000, signal);
  if (signal?.aborted) return { ok: false, status: 0, error: "Cancelado.", reintentar: true, permiso: false, cancelado: true };
  return pedirApi<T>(url, signal);
}

// ─── Formatos ─────────────────────────────────────────────────────────────────

export const fmtNum = (n: number, dec = 0) =>
  n.toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** Un km: entero desde 100, con un decimal por debajo. */
export const fmtKm = (n: number) => `${fmtNum(n, Math.abs(n) >= 100 ? 0 : 1)} km`;

export const fmtSoles = (n: number) => `S/ ${fmtNum(n, 2)}`;

export const fmtKg = (n: number) => `${fmtNum(n, Math.abs(n) >= 100 ? 0 : 1)} kg`;

export const fmtHoras = (h: number) => `${fmtNum(h, 1)} h`;

/** 75 → «1 h 15 min», 40 → «40 min». */
export function fmtMin(m: number): string {
  const t = Math.round(m);
  if (t < 60) return `${t} min`;
  const h = Math.floor(t / 60), r = t % 60;
  return r ? `${h} h ${String(r).padStart(2, "0")} min` : `${h} h`;
}

/** «2026-10-05» → «lun 05 oct» (sin hora: es una fecha de calendario). */
export function fmtFecha(f: string, conDia = true): string {
  const d = new Date(`${f}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return f;
  return d.toLocaleDateString("es-PE", { ...(conDia ? { weekday: "short" } : {}), day: "2-digit", month: "short", timeZone: "UTC" });
}

/** El nombre de una familia de combustible del catálogo («diesel» → «Diésel»). */
export function nombreFamilia(f: string): string {
  return FAMILIAS_TANQUE.find((x) => x.familia === f)?.label ?? f;
}

// ─── Recuadros ────────────────────────────────────────────────────────────────

/** Ámbar = cambia lo que hace (o lo que muestra) el sistema. */
export function Ambar({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 leading-snug">
      {children}
    </div>
  );
}

/** Rojo = no se pudo y hay que actuar. Con su botón de reintentar cuando reintentar sirve. */
export function ErrorConReintento({ texto, onReintentar }: { texto: string; onReintentar?: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex-1 min-w-[200px] leading-snug">{texto}</span>
      {onReintentar && (
        <button type="button" onClick={onReintentar}
          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white min-h-[36px]" style={{ background: "#0b315f" }}>
          Reintentar
        </button>
      )}
    </div>
  );
}

/** Informativo (gris-azul): no alarma, explica. */
export function Nota({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-slate-500 leading-snug bg-slate-50 rounded-lg px-3 py-2">{children}</p>;
}

/** Recuadro plegable «Cómo se mide». Cerrado por defecto: es para quien quiere saber. */
export function ComoSeMide({ children, titulo = "Cómo se mide" }: { children: React.ReactNode; titulo?: string }) {
  return (
    <details className="group rounded-2xl border bg-white shadow-sm">
      <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-bold text-gray-700 flex items-center gap-2">
        <span className="text-gray-400 transition-transform group-open:rotate-90">▸</span>
        {titulo}
      </summary>
      <div className="px-4 pb-4 text-xs text-gray-600 leading-relaxed space-y-3">{children}</div>
    </details>
  );
}

/** El sello «estimado» de una celda que no es una medición. */
export function Estimado() {
  return <span className="ml-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">estimado</span>;
}
