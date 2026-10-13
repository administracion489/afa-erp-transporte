"use client";

// components/seguimiento/ModalDiagnosticoRastreo.tsx — ¿POR QUÉ SE CORTÓ EL RASTREO?
//
// Se abre con un clic sobre el porcentaje de la columna RASTREO de /seguimiento (y desde las filas
// del aviso «unidades con rastreo incompleto»). Lo pidió el dueño así: «que salga como MODAL al dar
// click en el porcentaje de rastreo, en la misma página de seguimiento». Sirve para contestar si los
// cortes de un conductor son por su teléfono, por la configuración o por la red, y qué le falta
// configurar (caso real: VFC-962).
//
// ── ESTE COMPONENTE NO DIAGNOSTICA NADA ───────────────────────────────────────────────
// Todo sale de GET /api/seguimiento/rastreo/diagnostico, que mide con las MISMAS funciones que la
// celda (lib/gps-cobertura.ts) y diagnostica con lib/gps-diagnostico.ts. Ninguna frase de
// diagnóstico se compone aquí: el titular, el detalle, el texto de cada tramo, el resumen, los
// arreglos y la guía por marca vienen del motor. Aquí solo van las etiquetas de las secciones y
// de los códigos. Una frase armada en el TSX puede describir al revés lo que el sistema decide sin
// que nada falle (la ventana invertida del horario del conductor).
//
// ── TRI-ESTADO, SIEMPRE ───────────────────────────────────────────────────────────────
// Un ajuste del teléfono es ✓, ✗ o «— no se pudo comprobar» en gris. Un null NUNCA se pinta ✗:
// afirmar «batería con restricciones» de un teléfono que no contestó es acusar sin evidencia. Solo
// cuenta un booleano de verdad (valorCampo de lib/gps-equipo.ts); cualquier otra cosa es gris.
//
// ── SOLO PARA LA OPERACIÓN ────────────────────────────────────────────────────────────
// No tiene modo cliente y NO se importa en /cliente ni en /seguimiento/[token]: al cliente no se le
// enseña el porcentaje de rastreo (decisión del dueño, 09-10-2026), y este modal además nombra al
// conductor, su teléfono y su configuración.
//
// Mientras carga dice «Midiendo…»: nunca se afirma un vacío mientras se está buscando.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { cabecerasErp } from "@/lib/fetch-erp";
import { bandaCobertura, type VeredictoRastreo, type MedicionCobertura, type CodigoRastreo } from "@/lib/gps-cobertura";
import type { DiagnosticoRastreo, CausaCorte, TramoDiagnosticado, TramoCongelado, LlegadaTardia } from "@/lib/gps-diagnostico";
import {
  ACC_RED_M, CAMPOS_EQUIPO, ETIQUETA_CAMPO, FABRICANTES_AGRESIVOS, REPORTE_ANTERIOR_MS,
  faltasDeConfiguracion, guiaDeFabricante, valorCampo,
  type EstadoEquipo, type FaltaConfig, type PasoAjuste, type PlataformaEquipo,
} from "@/lib/gps-equipo";
import { hhmmLima, fechaLima, formatoDuracion } from "@/lib/servicio-tiempos";

// ══ Contrato de la respuesta (GET /api/seguimiento/rastreo/diagnostico) ═══════════════════
// Todo opcional a propósito: la respuesta puede venir de un error, de una migración sin correr o
// de una versión anterior del servidor. Cada sección se defiende de su campo ausente.

/** El estado del teléfono tal como sale a la pantalla: el servidor quita los identificadores de
 *  aparato (`dispositivos`); solo viaja CUÁNTOS reportaron (`aparatos`). */
type EstadoPantalla = Omit<EstadoEquipo, "dispositivos"> & { dispositivos?: string[] };
/** Para pasarle el estado de pantalla a las funciones del motor (no leen `dispositivos`). */
const comoEstado = (e: EstadoPantalla): EstadoEquipo => ({ ...e, dispositivos: Array.isArray(e.dispositivos) ? e.dispositivos : [] });

type EquipoRespuesta = {
  durante?: EstadoPantalla | null;
  anterior?: EstadoPantalla | null;
  ultimo?: EstadoPantalla | null;
  conductor?: { tabla?: string; id?: number; por?: "traza" | "reserva" } | null;
};

type RespuestaDiagnostico = {
  reserva_id?: number;
  fecha?: string | null;
  medido_en?: string | null;
  enCurso?: boolean;
  /** el mismo veredicto que la celda (contextoServicio + veredictoDeServicio) */
  veredicto?: VeredictoRastreo | null;
  medicion?: MedicionCobertura | null;
  diagnostico?: DiagnosticoRastreo | null;
  equipo?: EquipoRespuesta | null;
  migraciones?: { sql?: string; faltaTabla?: boolean; faltaRecibido?: boolean } | null;
  /** solo si el cálculo falló: el diagnóstico sale `sin_medir` y esto dice por qué */
  error?: string;
};

type ServicioHistorial = {
  reserva_id?: number;
  fecha?: string | null;
  hora?: string | null;
  placa?: string | null;
  veredicto?: { codigo?: CodigoRastreo; pct?: number | null; celda?: string; color?: string; bg?: string } | null;
};

type RespuestaHistorial = {
  servicios?: ServicioHistorial[];
  /** null solo si el historial no se pudo leer (entonces `error` dice por qué) */
  patron?: { codigo?: string; texto?: string } | null;
  recortado?: boolean;
  error?: string;
};

type Carga<T> = { fase: "cargando" } | { fase: "listo"; datos: T } | { fase: "error"; mensaje: string };

/** Respaldo si la respuesta no nombra su migración. */
const SQL_EQUIPO = "supabase/gps-equipo-01.sql";

/**
 * Un GET al ERP con la sesión. Traduce cada fallo a una frase que dice qué pasó: un 401/403 nombra
 * el permiso que falta (no «error 403»), un 4xx trae el motivo del servidor y la red caída se dice
 * como tal. `campo` es lo que la respuesta tiene que traer para darse por buena.
 */
async function pedir<T extends { error?: string }>(url: string, signal: AbortSignal, que: string, campo: keyof T): Promise<Carga<T>> {
  let r: Response;
  try {
    r = await fetch(url, { headers: await cabecerasErp(), signal, cache: "no-store" });
  } catch (e) {
    if (signal.aborted) throw e;
    return { fase: "error", mensaje: `No hay conexión con el servidor: no se pudo pedir ${que}. Revisa la red y reintenta.` };
  }
  const j = (await r.json().catch(() => null)) as T | null;
  if (signal.aborted) throw new Error("abortado");
  const msg = j && typeof j.error === "string" && j.error.trim() ? j.error.trim() : null;
  if (r.status === 401) return { fase: "error", mensaje: `Tu sesión venció: vuelve a iniciar sesión para ver ${que}.` };
  if (r.status === 403) {
    return { fase: "error", mensaje: msg && /inactiv/i.test(msg)
      ? `Tu usuario está inactivo: no puedes ver ${que}.`
      : `Te falta el permiso del módulo Seguimiento para ver ${que}. Lo da un administrador en Usuarios.` };
  }
  if (!r.ok) return { fase: "error", mensaje: msg ?? `El servidor no pudo calcular ${que} (HTTP ${r.status}).` };
  if (!j || typeof j !== "object") return { fase: "error", mensaje: `El servidor respondió algo que no se pudo leer al pedir ${que}.` };
  if (j[campo] == null && msg) return { fase: "error", mensaje: msg };
  return { fase: "listo", datos: j };
}

// ══ Formato (horas de Lima, UTC-5) ════════════════════════════════════════════════════════

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const hora = (ts: unknown): string => { const t = num(ts); return t != null ? hhmmLima(t) : "—"; };
function fechaHora(ts: unknown): string {
  const t = num(ts);
  if (t == null) return "—";
  const f = fechaLima(t);
  return `${f.slice(8, 10)}/${f.slice(5, 7)} ${hhmmLima(t)}`;
}
const fechaCorta = (iso: string | null | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—";
const fechaLarga = (iso: string | null | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
/** Misma regla que `minTxt` del motor: nunca «0 min» para un tramo que existe. */
const duracion = (s: unknown): string => { const v = num(s); return v == null ? "—" : formatoDuracion(Math.max(1, Math.round(v / 60))); };
const distancia = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const txt = (x: unknown): string => (typeof x === "string" ? x : "");

// ══ Etiquetas de los códigos (rótulos, no frases: las frases vienen del motor) ═══════════
// Colores con el criterio del ERP: ámbar = hay algo que cambiar en el teléfono; azul y gris =
// informativo. Mismos colores que el veredicto del motor para la causa equivalente.

const AMBAR = { color: "#92400e", bg: "#fef3c7" };
const AZUL = { color: "#1e40af", bg: "#dbeafe" };
const GRIS = { color: "#6b7280", bg: "#f3f4f6" };

const CAUSA: Record<CausaCorte, { label: string; color: string; bg: string }> = {
  app_detenida: { label: "App detenida", ...AMBAR },
  por_antena:   { label: "Por antena", ...AMBAR },
  sin_datos:    { label: "Sin datos móviles", ...AZUL },
  desconocida:  { label: "No se sabe", ...GRIS },
};
const CONGELADO = { label: "GPS congelado", ...AMBAR };
// «hueco» = entre dos posiciones, con el bus en marcha o quieto: «En ruta» se leía como carretera.
export const TIPO_TRAMO: Record<string, string> = { cabeza: "Al iniciar", hueco: "Entre dos posiciones", cola: "Al final" };

const PLATAFORMA: Record<PlataformaEquipo, string> = { apk: "App instalada (APK)", ios: "iPhone", navegador: "Navegador web" };

type ClaveEstado = "durante" | "anterior" | "ultimo";
const ETIQUETA_ESTADO: Record<ClaveEstado, string> = {
  durante: "Durante el servicio",
  anterior: "Antes del servicio",
  ultimo: "Último reporte",
};

const CODIGOS_BANDA: CodigoRastreo[] = ["completo", "aceptable", "con_cortes", "incompleto"];

// ══ Piezas ═════════════════════════════════════════════════════════════════════════════

function Seccion({ titulo, extra, children }: { titulo: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-[11px] font-black uppercase tracking-wide text-[#0b315f]">{titulo}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Midiendo({ que = "Midiendo…" }: { que?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
      <span className="w-3.5 h-3.5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin flex-shrink-0" />
      {que}
    </div>
  );
}

function Fallo({ mensaje, onReintentar }: { mensaje: string; onReintentar: () => void }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 flex items-start gap-3 flex-wrap">
      <p className="text-xs text-gray-600 flex-1 min-w-[180px] break-words">{mensaje}</p>
      <button type="button" onClick={onReintentar}
        className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-[#0b315f] text-[#0b315f] transition-colors">
        Reintentar
      </button>
    </div>
  );
}

function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return <span className="inline-block text-[10px] font-black px-1.5 py-0.5 rounded-md whitespace-nowrap" style={{ color, background: bg }}>{label}</span>;
}

/** ✓ / ✗ / «— no se pudo comprobar». Solo un booleano de verdad es ✓ o ✗. */
function Marca({ v }: { v: unknown }) {
  if (v === true) return <span className="font-black text-green-700" title="Bien">✓<span className="sr-only"> bien</span></span>;
  if (v === false) return <span className="font-black text-red-700" title="Mal">✗<span className="sr-only"> mal</span></span>;
  return <span className="text-gray-400 text-[11px]">— no se pudo comprobar</span>;
}

function FilaDato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-gray-50 last:border-b-0">
      <span className="text-[11px] text-gray-500">{etiqueta}</span>
      <span className="text-[11px] text-right text-[#0b315f] font-semibold break-words min-w-0">{children}</span>
    </div>
  );
}

// ══ Secciones ══════════════════════════════════════════════════════════════════════════

/** 4 · Los tramos que restan del % (con su causa) y los congelados, que no restan. */
function TablaTramos({ d }: { d: DiagnosticoRastreo }) {
  type Fila = { k: string; desdeTs: number; hastaTs: number; durS: number; km: number | null; tipo: string; etq: { label: string; color: string; bg: string }; texto: string };
  const filas: Fila[] = [];
  const tramos: TramoDiagnosticado[] = Array.isArray(d.tramos) ? d.tramos : [];
  const congelados: TramoCongelado[] = Array.isArray(d.congelados) ? d.congelados : [];
  tramos.forEach((t, i) => {
    const desde = num(t?.desdeTs), hasta = num(t?.hastaTs);
    if (desde == null || hasta == null) return;
    const av = num(t.avanceM);
    filas.push({
      k: `t${i}`, desdeTs: desde, hastaTs: hasta, durS: num(t.durS) ?? (hasta - desde) / 1000,
      km: t.enMovimiento === true && av != null ? av : null,
      tipo: TIPO_TRAMO[t.tipo] ?? "",
      etq: CAUSA[t.causa] ?? CAUSA.desconocida,
      texto: txt(t.texto),
    });
  });
  congelados.forEach((c, i) => {
    const desde = num(c?.desdeTs), hasta = num(c?.hastaTs);
    if (desde == null || hasta == null) return;
    filas.push({
      k: `c${i}`, desdeTs: desde, hastaTs: hasta, durS: num(c.durS) ?? (hasta - desde) / 1000,
      km: num(c.saltoM), tipo: "No resta del %", etq: CONGELADO, texto: txt(c.texto),
    });
  });
  filas.sort((a, b) => a.desdeTs - b.desdeTs);

  return (
    <>
      {txt(d.resumen) && <p className="text-xs font-bold text-gray-600">{d.resumen}</p>}
      {filas.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-100">
          <table className="w-full text-left">
            <thead className="bg-gray-50">
              <tr className="text-[9px] font-black uppercase text-gray-400">
                <th className="px-3 py-1.5">Desde – hasta</th>
                <th className="px-2 py-1.5">Duración</th>
                <th className="px-2 py-1.5" title="Solo en los tramos en que el bus avanzó: es la distancia entre la posición de antes y la de después">Km</th>
                <th className="px-2 py-1.5">Causa</th>
              </tr>
            </thead>
            {filas.map((f) => (
              <tbody key={f.k} className="border-t border-gray-100">
                <tr className="align-top">
                  <td className="px-3 pt-2 font-mono text-xs font-black text-[#0b315f] whitespace-nowrap">
                    {hora(f.desdeTs)}–{hora(f.hastaTs)}
                    {f.tipo && <span className="block font-sans text-[9px] font-bold text-gray-400 uppercase">{f.tipo}</span>}
                  </td>
                  <td className="px-2 pt-2 text-xs font-bold text-gray-600 whitespace-nowrap">{duracion(f.durS)}</td>
                  <td className="px-2 pt-2 text-xs font-bold text-gray-600 whitespace-nowrap">{f.km != null ? distancia(f.km) : <span className="text-gray-300">—</span>}</td>
                  <td className="px-2 pt-2"><Chip {...f.etq} /></td>
                </tr>
                <tr>
                  <td colSpan={4} className="px-3 pt-1 pb-2.5 text-[11px] text-gray-600 leading-snug break-words">{f.texto}</td>
                </tr>
              </tbody>
            ))}
          </table>
        </div>
      )}
    </>
  );
}

/** 5 · ¿Llegó algo tarde? (falta de datos móviles: casi nunca deja hueco). */
function Entregas({ d }: { d: DiagnosticoRastreo }) {
  const e = d.entregas;
  if (!e) return <p className="text-xs text-gray-400">El servidor no devolvió las llegadas de las posiciones.</p>;
  if (e.medible === true) {
    const tardias: LlegadaTardia[] = Array.isArray(e.tardias) ? e.tardias : [];
    return (
      <div className="space-y-1.5">
        <p className={`text-xs leading-snug ${tardias.length ? "text-[#1e40af]" : "text-gray-600"}`}>{txt(e.texto)}</p>
        {tardias.length > 0 && (
          <ul className="space-y-1">
            {tardias.map((t, i) => (
              <li key={i} className="text-[11px] text-gray-600 leading-snug rounded-lg bg-[#eff6ff] px-2.5 py-1.5 break-words">{txt(t.texto)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  // Sin la columna recibido_en no se puede medir: ámbar, nombrando el SQL (el texto del motor lo nombra).
  if (e.motivo === "sin_columna") {
    return <p className="text-xs leading-snug rounded-lg px-2.5 py-2 break-words" style={{ color: AMBAR.color, background: AMBAR.bg }}>{txt(e.texto)}</p>;
  }
  return <p className="text-xs text-gray-500 leading-snug">{txt(e.texto)}</p>;
}

/** 6 · Cómo estaba configurado su teléfono. */
function Telefono({ est }: { est: EstadoPantalla }) {
  const fabricante = txt(est.fabricante);
  const marca = !fabricante || fabricante === "generico" ? "Marca no identificada" : txt(est.marca) || fabricante;
  const plataformas = Array.isArray(est.plataformas) ? est.plataformas : [];
  const plugins = Array.isArray(est.plugins) ? est.plugins : [];
  const aparatos = num(est.aparatos) ?? 0;
  const debil = num(est.gps_debil_m);
  const cola = num(est.pendientes_cola);
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-gray-100 px-3 py-1">
        <FilaDato etiqueta="Periodo">
          {fechaHora(est.desdeTs)} → {fechaHora(est.hastaTs)}
          {num(est.reportes) != null && <span className="text-gray-400 font-normal"> · {est.reportes} reporte(s)</span>}
        </FilaDato>
        <FilaDato etiqueta="Plataforma">
          {est.plataforma ? PLATAFORMA[est.plataforma] ?? est.plataforma : <span className="text-gray-400 font-normal">— no informada</span>}
          {plataformas.length > 1 && <span className="text-gray-400 font-normal"> (también {plataformas.filter((p) => p !== est.plataforma).map((p) => PLATAFORMA[p] ?? p).join(", ")})</span>}
        </FilaDato>
        <FilaDato etiqueta="Marca y modelo">
          {marca}{est.modelo ? ` · ${est.modelo}` : <span className="text-gray-400 font-normal"> · modelo no informado</span>}
        </FilaDato>
        <FilaDato etiqueta="Android">
          {est.android ? est.android : <span className="text-gray-400 font-normal">— no se sabe</span>}
        </FilaDato>
        {txt(est.nivelApk?.texto) && <FilaDato etiqueta="App"><span className="font-normal text-gray-700">{est.nivelApk.texto}</span></FilaDato>}
      </div>

      <div className="rounded-xl border border-gray-100 px-3 py-1">
        {CAMPOS_EQUIPO.map((c) => (
          <FilaDato key={c} etiqueta={ETIQUETA_CAMPO[c]}><Marca v={valorCampo(comoEstado(est), c)} /></FilaDato>
        ))}
        <FilaDato etiqueta="Precisión medida del GPS">
          {debil == null
            ? <span className="text-gray-400 font-normal">— sin muestras</span>
            : <span title={`Por encima de ${ACC_RED_M} m es ubicación por antena, no por satélite`}>
                <Marca v={debil < ACC_RED_M} /> ±{debil} m
              </span>}
        </FilaDato>
        <FilaDato etiqueta="GPS atascado">
          {est.gps_atascado === true ? <span className="text-red-700">✗ Sí</span>
            : est.gps_atascado === false ? <span className="text-green-700">✓ No</span>
            : <Marca v={null} />}
        </FilaDato>
      </div>

      {aparatos > 1 && (
        <p className="text-[11px] leading-snug rounded-lg px-2.5 py-1.5" style={{ color: AMBAR.color, background: AMBAR.bg }}>
          Reportaron {aparatos} teléfonos distintos en este periodo.
        </p>
      )}

      {/* El user-agent crudo va como TEXTO: React lo escapa. Nunca dangerouslySetInnerHTML. */}
      <details className="rounded-xl border border-gray-100 px-3 py-2 text-[11px] text-gray-500">
        <summary className="cursor-pointer font-bold text-gray-500 select-none">Detalle técnico</summary>
        <dl className="mt-2 space-y-1.5">
          <div><dt className="font-bold text-gray-400">User agent</dt><dd className="font-mono break-all text-gray-600">{txt(est.userAgent) || "—"}</dd></div>
          <div><dt className="font-bold text-gray-400">Módulos de la app</dt><dd className="text-gray-600">{plugins.length ? plugins.join(", ") : "ninguno"}</dd></div>
          <div><dt className="font-bold text-gray-400">Teléfonos que reportaron</dt><dd className="text-gray-600">{aparatos || "—"}</dd></div>
          {cola != null && <div><dt className="font-bold text-gray-400">Posiciones en cola sin enviar (máx.)</dt><dd className="text-gray-600">{cola}</dd></div>}
        </dl>
      </details>
    </div>
  );
}

/** 7 · Qué le falta configurar (+ los pasos de su marca). */
function QueFalta({ faltas, guia, fuente }: {
  faltas: (FaltaConfig & { explica: boolean })[];
  guia: { fabricante: string; marca: string; pasos: PasoAjuste[]; agresivo: boolean } | null;
  fuente: string;
}) {
  const pasos = guia && Array.isArray(guia.pasos) ? guia.pasos : [];
  const titulo = !guia ? "" : !guia.fabricante || guia.fabricante === "generico" ? "Pasos generales (marca no identificada)" : `Pasos para ${guia.marca}`;
  return (
    <div className="space-y-2">
      {fuente && <p className="text-[10px] font-bold uppercase text-gray-400">Según: {fuente}</p>}
      {faltas.length > 0 ? (
        <ul className="space-y-1.5">
          {faltas.map((f, i) => (
            <li key={`${f.campo}-${i}`} className="rounded-xl border px-3 py-2"
              style={f.explica ? { borderColor: "#fcd34d", background: "#fffbeb" } : { borderColor: "#f3f4f6" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black text-red-700">✗</span>
                <span className="text-xs font-black text-[#0b315f]">{txt(f.titulo)}</span>
                {f.explica && <Chip label="Explica el corte" {...AMBAR} />}
              </div>
              <p className="text-[11px] text-gray-600 leading-snug mt-0.5 break-words">{txt(f.arreglo)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">Ninguno de los ajustes que la app comprueba está en ✗.</p>
      )}
      {guia && pasos.length > 0 && (
        // En las marcas que cierran apps por su cuenta los pasos van abiertos, igual que en la app.
        <details open={guia.agresivo} className="rounded-xl border border-gray-100 px-3 py-2">
          <summary className="cursor-pointer text-xs font-black text-[#0b315f] select-none">{titulo}</summary>
          <p className="text-[11px] text-gray-500 leading-snug mt-1.5">
            El inicio automático y el bloqueo de la app en Recientes son ajustes del fabricante que la app
            no puede leer: hay que revisarlos en el teléfono, con el conductor. La batería y la ubicación
            sí las comprueba cuando el teléfono contesta (arriba, con ✓ o ✗).
          </p>
          <ol className="mt-2 space-y-1.5 list-decimal pl-4">
            {pasos.map((p, i) => (
              <li key={i} className="text-[11px] text-gray-600 leading-snug">
                <span className="font-bold text-[#0b315f]">{txt(p?.titulo)}</span>
                {txt(p?.detalle) && <span className="block break-words">{p.detalle}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

// ══ El modal ═══════════════════════════════════════════════════════════════════════════

export type PropsModalDiagnosticoRastreo = {
  reservaId: number;
  fecha: string | null;
  placa: string;
  conductorNombre: string;
  conductorTel: string;
  horaServicio: string | null;
  clienteNombre: string;
  /** el veredicto de la celda en la que se hizo clic (se enseña mientras llega el del servidor) */
  rastreo: VeredictoRastreo | null;
  onAbrirGps?: () => void;
  onClose: () => void;
};

export default function ModalDiagnosticoRastreo({
  reservaId, fecha, placa, conductorNombre, conductorTel, horaServicio, clienteNombre, rastreo, onAbrirGps, onClose,
}: PropsModalDiagnosticoRastreo) {
  const tituloId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const abajoEnFondo = useRef(false);

  // Cada carga se guarda con la CLAVE con que se pidió: si cambia (reintento), lo viejo no se pinta
  // y la fase vuelve a «cargando» sin poner estado dentro del efecto.
  const [intentoDiag, setIntentoDiag] = useState(0);
  const [intentoHist, setIntentoHist] = useState(0);
  const claveDiag = `${reservaId}:${intentoDiag}`;
  const claveHist = `${reservaId}:${intentoHist}`;
  const [diagRes, setDiagRes] = useState<{ clave: string; carga: Carga<RespuestaDiagnostico> } | null>(null);
  const [histRes, setHistRes] = useState<{ clave: string; carga: Carga<RespuestaHistorial> } | null>(null);
  const [verEstado, setVerEstado] = useState<ClaveEstado | null>(null);

  // Los dos pedidos salen en paralelo y no se esperan: el historial no retrasa el diagnóstico.
  useEffect(() => {
    const ctl = new AbortController();
    pedir<RespuestaDiagnostico>(`/api/seguimiento/rastreo/diagnostico?reserva=${encodeURIComponent(String(reservaId))}`, ctl.signal, "el diagnóstico", "diagnostico")
      .then((carga) => { if (!ctl.signal.aborted) setDiagRes({ clave: claveDiag, carga }); })
      .catch(() => { /* abortado al cerrar o al reintentar */ });
    return () => ctl.abort();
  }, [reservaId, claveDiag]);

  useEffect(() => {
    const ctl = new AbortController();
    pedir<RespuestaHistorial>(`/api/seguimiento/rastreo/diagnostico?reserva=${encodeURIComponent(String(reservaId))}&historial=1`, ctl.signal, "sus últimos servicios", "servicios")
      .then((carga) => { if (!ctl.signal.aborted) setHistRes({ clave: claveHist, carga }); })
      .catch(() => { /* abortado al cerrar o al reintentar */ });
    return () => ctl.abort();
  }, [reservaId, claveHist]);

  // Esc cierra; el foco entra al modal para que Esc y el lector de pantalla lo encuentren.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  useEffect(() => { panelRef.current?.focus(); }, []);

  const diag: Carga<RespuestaDiagnostico> = diagRes?.clave === claveDiag ? diagRes.carga : { fase: "cargando" };
  const hist: Carga<RespuestaHistorial> = histRes?.clave === claveHist ? histRes.carga : { fase: "cargando" };

  const datos = diag.fase === "listo" ? diag.datos : null;
  const d = datos?.diagnostico ?? null;
  // El chip de arriba es el del servidor en cuanto llega (de él salen los tramos de abajo); mientras
  // tanto, el de la celda en la que se hizo clic.
  const vered: VeredictoRastreo | null = datos?.veredicto ?? rastreo ?? null;
  const enCurso = datos?.enCurso ?? vered?.enCurso ?? false;
  const medidoTs = datos?.medido_en ? Date.parse(datos.medido_en) : NaN;
  const equipo = datos?.equipo ?? null;
  const mig = datos?.migraciones ?? null;
  const sqlNombre = txt(mig?.sql) || SQL_EQUIPO;

  // ── El teléfono: qué estado se enseña (por defecto, el que usó el diagnóstico) ──
  const opciones = (["durante", "anterior", "ultimo"] as const).filter((k) => !!equipo?.[k]);
  const usado = d?.estadoUsado && equipo?.[d.estadoUsado] ? d.estadoUsado : null;
  const sel: ClaveEstado | null = verEstado && equipo?.[verEstado] ? verEstado : usado ?? opciones[0] ?? null;
  const est = sel ? equipo?.[sel] ?? null : null;

  // ── Qué le falta: lo que juzgó el diagnóstico (durante, o hasta 24 h antes). Si el teléfono no
  // reportó en ese tramo pero sí hay un último reporte, se leen sus faltas con el MISMO motor
  // (faltasDeConfiguracion), dicho como tal: ninguna «explica» el corte.
  const ultimo = equipo?.ultimo ?? null;
  const conf: { faltas: (FaltaConfig & { explica: boolean })[]; guia: { fabricante: string; marca: string; pasos: PasoAjuste[]; agresivo: boolean } | null; fuente: string } | null =
    d?.estadoUsado
      ? { faltas: Array.isArray(d.faltas) ? d.faltas : [], guia: d.guia ?? null, fuente: ETIQUETA_ESTADO[d.estadoUsado] }
      : ultimo
        ? (() => {
            const g = guiaDeFabricante(txt(ultimo.fabricante));
            return {
              faltas: faltasDeConfiguracion(comoEstado(ultimo)).faltas.map((f) => ({ ...f, explica: false })),
              guia: { fabricante: txt(ultimo.fabricante), marca: g.marca, pasos: g.pasos, agresivo: FABRICANTES_AGRESIVOS.includes(txt(ultimo.fabricante)) },
              fuente: `${ETIQUETA_ESTADO.ultimo} (${fechaHora(ultimo.hastaTs)})`,
            };
          })()
        : null;

  const tituloFecha = fechaLarga(fecha);
  const reintentarDiag = () => setIntentoDiag((n) => n + 1);
  const reintentarHist = () => setIntentoHist((n) => n + 1);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
      style={{ background: "rgba(15,23,42,0.65)" }}
      // Cierra solo si el clic EMPEZÓ y TERMINÓ en el fondo: seleccionar un texto del modal y soltar
      // fuera no tiene que cerrarlo.
      onMouseDown={(e) => { abajoEnFondo.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (abajoEnFondo.current && e.target === e.currentTarget) onClose(); abajoEnFondo.current = false; }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={tituloId} tabIndex={-1}
        className="bg-white w-full sm:max-w-3xl h-dvh sm:h-auto sm:max-h-[92vh] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden outline-none">

        {/* 1 · CABECERA */}
        <div className="flex-shrink-0 px-4 sm:px-5 py-3 flex items-start justify-between gap-3" style={{ background: "#0b315f" }}>
          <div className="min-w-0">
            <p id={tituloId} className="text-white font-black text-sm">
              Diagnóstico del rastreo <span className="text-blue-200 font-bold">· Reserva #{reservaId}{tituloFecha ? ` · ${tituloFecha}` : ""}</span>
            </p>
            <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px] text-blue-100 mt-0.5">
              <span className="font-mono font-black text-white">{placa || "—"}</span>
              <span className="text-blue-300">·</span>
              <span className="break-words">{conductorNombre || "—"}</span>
              {conductorTel && (
                <>
                  <span className="text-blue-300">·</span>
                  <a href={`tel:${conductorTel}`} className="font-bold text-green-300 underline">{conductorTel}</a>
                </>
              )}
              {horaServicio && (<><span className="text-blue-300">·</span><span>{horaServicio.slice(0, 5)}</span></>)}
              {clienteNombre && (<><span className="text-blue-300">·</span><span className="break-words">{clienteNombre}</span></>)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar"
            className="w-8 h-8 flex-shrink-0 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white text-lg transition-colors">✕</button>
        </div>

        {/* CUERPO */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-5">

          {/* 2 · LA BANDA: el mismo chip que la celda, con su frase. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] font-bold uppercase text-gray-400">Rastreo</span>
              {vered ? (
                <>
                  <span className="inline-block text-sm font-black px-2 py-0.5 rounded-lg whitespace-nowrap" style={{ color: vered.color, background: vered.bg }}>{vered.celda}</span>
                  {CODIGOS_BANDA.includes(vered.codigo) && vered.pct != null && (
                    <span className="text-xs font-bold" style={{ color: vered.color }}>{bandaCobertura(vered.pct).label}</span>
                  )}
                </>
              ) : diag.fase === "cargando" ? <Midiendo /> : <span className="text-xs text-gray-400">—</span>}
              {enCurso && Number.isFinite(medidoTs) && <span className="text-[11px] text-gray-400">En curso · medido {hhmmLima(medidoTs)}</span>}
            </div>
            {vered && txt(vered.detalle) && <p className="text-xs text-gray-600 leading-snug break-words">{vered.detalle}</p>}
          </div>

          {/* AVISO DE MIGRACIÓN: arriba, porque explica por qué partes de abajo salen vacías. */}
          {(mig?.faltaTabla || mig?.faltaRecibido) && (
            <p className="text-xs leading-snug rounded-xl px-3 py-2.5 break-words" style={{ color: AMBAR.color, background: AMBAR.bg }}>
              <b>Falta correr {sqlNombre}</b> (el despliegue no la corre). Mientras tanto
              {mig?.faltaTabla ? " la app del conductor no puede reportar cómo está configurado su teléfono y aquí no se ve" : ""}
              {mig?.faltaTabla && mig?.faltaRecibido ? ", y" : ""}
              {mig?.faltaRecibido ? " no se puede saber qué posiciones llegaron tarde (falta de datos móviles)" : ""}.
            </p>
          )}

          {/* 3 · EL VEREDICTO */}
          <Seccion titulo="Por qué se cortó">
            {diag.fase === "cargando" ? <Midiendo />
              : diag.fase === "error" ? <Fallo mensaje={diag.mensaje} onReintentar={reintentarDiag} />
              : !d ? <Fallo mensaje="El servidor no devolvió el diagnóstico de este servicio." onReintentar={reintentarDiag} />
              : (
                <>
                  <div className="rounded-xl px-3.5 py-3 border" style={{ background: d.bg || GRIS.bg, borderColor: `${d.color || GRIS.color}33` }}>
                    <p className="text-sm font-black leading-snug" style={{ color: d.color || GRIS.color }}>{txt(d.titular)}</p>
                    {txt(d.detalle) && <p className="text-xs leading-snug mt-1 break-words" style={{ color: d.color || GRIS.color }}>{d.detalle}</p>}
                  </div>
                  {/* El cálculo falló a medias: el diagnóstico sale «sin medir» y el servidor dice por qué. */}
                  {txt(datos?.error) && <Fallo mensaje={txt(datos?.error)} onReintentar={reintentarDiag} />}
                </>
              )}
          </Seccion>

          {d && (
            <>
              {/* 4 · TRAMOS SIN RASTREO */}
              <Seccion titulo="Tramos sin rastreo">
                <TablaTramos d={d} />
              </Seccion>

              {/* 5 · LLEGADAS TARDÍAS */}
              <Seccion titulo="¿Llegó algo tarde?">
                <Entregas d={d} />
              </Seccion>

              {/* 6 · SU TELÉFONO */}
              <Seccion titulo="Su teléfono"
                extra={opciones.length > 1 ? (
                  <div className="flex gap-1 bg-gray-50 rounded-lg p-0.5">
                    {opciones.map((k) => (
                      <button key={k} type="button" onClick={() => setVerEstado(k)}
                        className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${sel === k ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}>
                        {ETIQUETA_ESTADO[k]}
                      </button>
                    ))}
                  </div>
                ) : undefined}>
                {est && sel ? (
                  <>
                    <p className="text-[10px] font-bold uppercase text-gray-400">
                      {ETIQUETA_ESTADO[sel]}{usado === sel ? " · es el que usa el diagnóstico" : ""}
                    </p>
                    <Telefono est={est} />
                  </>
                ) : mig?.faltaTabla ? (
                  <p className="text-xs text-gray-500">No se ve hasta correr {sqlNombre}.</p>
                ) : equipo && equipo.conductor === null ? (
                  <p className="text-xs text-gray-500">No se identificó al conductor del servicio: no hay de quién buscar los reportes del teléfono.</p>
                ) : (
                  <p className="text-xs text-gray-500">Sin reportes del teléfono de este conductor.</p>
                )}
              </Seccion>

              {/* 7 · QUÉ LE FALTA CONFIGURAR */}
              <Seccion titulo="Qué le falta configurar">
                {conf ? <QueFalta faltas={conf.faltas} guia={conf.guia} fuente={conf.fuente} />
                  : mig?.faltaTabla ? <p className="text-xs text-gray-500">No se ve hasta correr {sqlNombre}.</p>
                  : <p className="text-xs text-gray-500">Sin reporte del teléfono durante el servicio ni en las {Math.round(REPORTE_ANTERIOR_MS / 3600_000)} h anteriores: no se puede saber qué le falta.</p>}
              </Seccion>
            </>
          )}

          {/* 8 · SUS ÚLTIMOS SERVICIOS (carga aparte) */}
          <Seccion titulo="Sus últimos servicios"
            extra={<Link href="/gps-salud" className="text-[11px] font-bold text-[#1d4ed8] underline">Salud del GPS →</Link>}>
            {hist.fase === "cargando" ? <Midiendo />
              : hist.fase === "error" ? <Fallo mensaje={hist.mensaje} onReintentar={reintentarHist} />
              : txt(hist.datos.error) && !hist.datos.patron ? <Fallo mensaje={txt(hist.datos.error)} onReintentar={reintentarHist} />
              : (() => {
                  const servicios = Array.isArray(hist.datos.servicios) ? hist.datos.servicios : [];
                  const patron = txt(hist.datos.patron?.texto);
                  return (
                    <div className="space-y-2">
                      {servicios.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {servicios.map((s, i) => {
                            const v = s?.veredicto ?? null;
                            return (
                              <span key={s?.reserva_id ?? i} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-100 px-2 py-1 text-[11px]"
                                title={s?.reserva_id ? `Reserva #${s.reserva_id}` : undefined}>
                                <span className="font-bold text-gray-500">{fechaCorta(s?.fecha)}{s?.hora ? ` ${String(s.hora).slice(0, 5)}` : ""}</span>
                                {s?.placa && <span className="font-mono font-black text-[#0b315f]">{s.placa}</span>}
                                <span className="font-black px-1 rounded" style={{ color: v?.color || GRIS.color, background: v?.bg || GRIS.bg }}>{txt(v?.celda) || "—"}</span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {patron && <p className="text-xs text-gray-600 leading-snug">{patron}</p>}
                      {hist.datos.recortado && <p className="text-[10px] text-gray-400">Se muestran los más recientes.</p>}
                    </div>
                  );
                })()}
          </Seccion>
        </div>

        {/* PIE */}
        <div className="flex-shrink-0 border-t border-gray-100 px-4 sm:px-5 py-3 flex items-center justify-end gap-2 flex-wrap bg-white">
          {onAbrirGps && (
            <button type="button" onClick={onAbrirGps}
              className="px-4 py-2 rounded-xl bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-xs font-bold transition-colors">
              🗺️ Ver el recorrido en el mapa
            </button>
          )}
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-xl bg-[#0b315f] hover:bg-[#1262bd] text-white text-xs font-bold transition-colors">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
