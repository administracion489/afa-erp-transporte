"use client";

// components/seguimiento/FichaServicio.tsx — el drawer de un servicio en /seguimiento.
//
// ══════════════════════════════════════════════════════════════════════════════
// QUÉ SUSTITUYE Y POR QUÉ
//
// El drawer anterior (app/seguimiento/page.tsx:1246 `FichaServicio`) pintaba una métrica
// enorme "CHECK-IN · No iniciado" en ROJO para servicios FINALIZADOS al 100 %. No era un
// error de cálculo: leía `reservas.checkin_realizado`, un booleano que SOLO escribe un botón
// manual del propio drawer. Medición sobre producción (30 días, corte 2026-08-20):
//
//     575 servicios operados
//       reservas.hora_real_inicio ...  1 de 575
//       reservas.hora_real_fin ......  0 de 575   ← CERO en un mes
//
// Mientras tanto la hora real SÍ existía, en `paradas.hora_llegada`, escrita por el conductor
// al entrar al geocerco (app/api/conductor/route.ts:460) en el 90 % de las paradas completadas.
// Nadie la mostraba. Este componente no inventa un dato nuevo: enseña el que ya estaba.
//
// Toda la lógica dura vive fuera, en tres módulos ya escritos y verificados:
//   · lib/servicio-tiempos.ts    → derivarTiempos(): la hora real y DE DÓNDE salió.
//   · lib/documentos-estado.ts   → evaluarAptitud(): apto/no apto contra la FECHA DEL SERVICIO.
//   · lib/ficha-servicio-datos.ts→ cargarFichaDatos(): la red, lazy y resiliente.
// Aquí solo se PINTA. Si algo hay que corregir en el veredicto, se corrige en el motor.
//
// ══════════════════════════════════════════════════════════════════════════════
// DISCIPLINA VISUAL: lo verde se colapsa, solo lo rojo/ámbar nace abierto.
// Un drawer que grita por todo enseña al operador a no mirarlo. Los bloques conformes
// (documentos al día, todos abordaron) se resumen en UNA línea con su contador; los
// hallazgos que exigen actuar salen desplegados y arriba del todo.
//
// ══════════════════════════════════════════════════════════════════════════════
// DECISIONES DEL DUEÑO (2026-08-20) respetadas literalmente:
//   · Fin: se muestran las DOS horas (llegada al último paradero y cierre del conductor)
//     cuando difieren. La primera es la que factura; la segunda es la operativa.
//   · Documento obligatorio SIN CARGAR: avisa en ÁMBAR, NO bloquea. Solo bloquea el que
//     está cargado Y vencido — y esa regla la aplica el motor (`hallazgo.bloquea`), aquí
//     jamás se replica.
//   · Registro manual de la salida: SOLO cuando no hay ninguna evidencia de la que
//     derivarla (`puedeRegistrarInicioManual`), y queda marcado como manual.
//   · precio_cliente / costo_proveedor / margen: SOLO rol admin (`esAdmin`).
//
// ══════════════════════════════════════════════════════════════════════════════
// LO QUE ESTE ARCHIVO NO HACE, DELIBERADAMENTE
//   · No persiste ninguna hora derivada. Una hora inferida por GPS que se guarde como
//     `hora_real_inicio` deja de ser estimación y pasa a ser un dato que alguien factura
//     (doctrina de la casa: lib/avance-paradas.ts:30). Lo único que se escribe desde aquí
//     es lo que un humano teclea, y va a la fuente "operador".
//   · No inventa el MÉTODO de abordaje. `pasajeros_parada` no tiene columna de método
//     (el "qr_conductor" vive en `boarding_log`, tabla sin backfill), así que se muestra
//     "06:03 · Paradero 3" y NUNCA "· QR": un dato decorativo que no se puede verificar es
//     exactamente lo que hizo inservible al check-in.
//   · No mueve los modales de gastos / checklist / reemplazo: viven en page.tsx y llegan
//     por `children`. Ver la sección 8.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { ESTADOS_RESERVA, ESTADOS_ADMIN, ESTADO_ADMIN_INICIAL, normalizaEstado } from "@/lib/estados";
import { idAfa } from "@/lib/folio";
import {
  manifiestoMtcHTML, reporteServicioHTML, abrirImprimible, esAbordado,
  type DocPasajero,
} from "@/lib/documentos-servicio";
import { cargarFichaDatos, type FichaDatos } from "@/lib/ficha-servicio-datos";
import {
  derivarTiempos, procedencia, formatoDuracion, puedeRegistrarInicioManual,
  NIVEL_SALIDA, type FilaLinea, type Instante, type NivelSalida, type TiemposServicio,
} from "@/lib/servicio-tiempos";
import {
  evaluarAptitud, VEREDICTO_DOC_CFG, type AptitudServicio, type HallazgoDoc,
} from "@/lib/documentos-estado";

// ══════════════════════════════════════════════════════════════════════════════
// ICONOS
// El objeto `Ic` de app/seguimiento/page.tsx NO está exportado y esa página la está
// editando otra sesión: importarlo obligaría a tocarla. Se redibujan aquí los pocos que
// se usan, con el MISMO trazo (feather, viewBox 24, strokeWidth 1.8-2) para que un ícono
// no se vea distinto según el panel.
// ══════════════════════════════════════════════════════════════════════════════

type IP = { size?: number; strokeWidth?: number; className?: string; color?: string };
const svg = (p: IP, hijos: React.ReactNode) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none"
    stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2}
    strokeLinecap="round" strokeLinejoin="round" className={p.className} aria-hidden="true">
    {hijos}
  </svg>
);
const I = {
  Bus: (p: IP) => svg(p, <><path d="M8 6v6" /><path d="M16 6v6" /><path d="M2 12h19.6" /><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3" /><circle cx="7" cy="18" r="2" /><circle cx="15" cy="18" r="2" /></>),
  Map: (p: IP) => svg(p, <><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" /><line x1="9" y1="3" x2="9" y2="18" /><line x1="15" y1="6" x2="15" y2="21" /></>),
  FileText: (p: IP) => svg(p, <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>),
  Check: (p: IP) => svg(p, <polyline points="20 6 9 17 4 12" />),
  X: (p: IP) => svg(p, <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>),
  Phone: (p: IP) => svg(p, <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1.21h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 5.95 5.95l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.72 16.92z" />),
  Shield: (p: IP) => svg(p, <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />),
  DollarSign: (p: IP) => svg(p, <><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>),
  ChevronDown: (p: IP) => svg(p, <polyline points="6 9 12 15 18 9" />),
  Users: (p: IP) => svg(p, <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>),
  Clock: (p: IP) => svg(p, <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>),
  Alert: (p: IP) => svg(p, <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>),
  Swap: (p: IP) => svg(p, <><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>),
  Building: (p: IP) => svg(p, <><rect x="4" y="2" width="16" height="20" rx="2" /><line x1="9" y1="6" x2="9" y2="6.01" /><line x1="15" y1="6" x2="15" y2="6.01" /><line x1="9" y1="11" x2="9" y2="11.01" /><line x1="15" y1="11" x2="15" y2="11.01" /><path d="M10 22v-4h4v4" /></>),
};

// ══════════════════════════════════════════════════════════════════════════════
// PALETA Y HELPERS DE PRESENTACIÓN
// ══════════════════════════════════════════════════════════════════════════════

// Azul institucional #0b315f, hover #1262bd, fondo del drawer #eef3f8. Van escritos en las
// clases de Tailwind (arbitrary values) igual que en el resto de /seguimiento, no en
// constantes: así una búsqueda de "#0b315f" en el repo sigue encontrando este archivo.

/** Anillo de foco visible. La ficha se opera con teclado (ESC cierra, Tab recorre). */
const FOCO = "outline-none focus-visible:ring-2 focus-visible:ring-[#1262bd] focus-visible:ring-offset-1";

const ETIQUETA = "text-[10px] font-bold uppercase tracking-wider text-gray-400";
const TARJETA = "bg-white rounded-2xl border border-gray-100";

/** "2026-08-20" → "20/08/2026". Tabla fija, no toLocaleDateString: el locale del equipo
 *  del operador no tiene por qué ser es-PE. */
function fechaDMY(f: string | null | undefined): string {
  const p = String(f || "").slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : "—";
}

const soles = (n: number | null | undefined) => `S/ ${Number(n || 0).toFixed(2)}`;

// Estados de `pasajeros_parada`. El abordaje POSITIVO lo decide `esAbordado()` de
// lib/documentos-servicio.ts (fuente única en todo el ERP); estos dos cubren los dos
// negativos que sí hay que distinguir. Valores reales del manifiesto, verificados en
// app/api/pasajero/route.ts:144 y lib/push.ts:305 — "Pendiente" | "Abordado" | "No Show" |
// "Cancelado" en `estado_abordaje`, y la columna gemela `estado` que escribe la app del
// conductor ("no_show"). Se miran las DOS porque un trigger las sincroniza pero hay filas
// históricas con solo una.
const esNoShow = (x: any) => x?.estado_abordaje === "No Show" || x?.estado === "no_show";
const esCancelado = (x: any) => x?.estado_abordaje === "Cancelado" || x?.estado === "cancelado";

/**
 * Nombre honesto de cada pieza que pudo fallar al cargar. `fallos` viene de
 * cargarFichaDatos y existe justo para no pintar un cero que parezca un hecho: "0
 * pasajeros" y "no pude leer la lista de pasajeros" son cosas distintas.
 */
const NOMBRE_FALLO: Record<string, string> = {
  roster: "la lista de pasajeros",
  abordajes: "las horas de abordaje",
  paradas: "las paradas y sus horas de llegada",
  conductor: "los datos del conductor",
  empresa: "el operador tercerizado",
  docs_unidad: "los documentos de la unidad",
  eventos: "el aviso de salida a los pasajeros",
  gps: "el rastro GPS",
  cliente: "el RUC del cliente",
  edad: "la edad de los pasajeros",
};

/**
 * EL CONTRATO CON EL LOADER (lib/ficha-servicio-datos.ts).
 *
 * `derivarTiempos` recibe LISTAS, no un canal de error: no puede distinguir "no hay evidencia"
 * de "no pude leer la evidencia". Con `paradas`, `abordajes`, `gps` y `eventos` vacíos por una
 * consulta caída dictamina `no_arranco` — ROJO — sobre un servicio que SÍ operó, que es el
 * mismísimo falso positivo que este rediseño existe para borrar, entrando por la puerta de atrás.
 *
 * El trato tiene dos mitades:
 *   · el loader garantiza que `fallos` se llena SIEMPRE que una lectura falla;
 *   · este componente comprueba `fallos` ANTES de pintar cualquier veredicto rojo.
 *
 * Estas son las piezas que alimentan el veredicto de salida. "roster" está en la lista porque HOY
 * el loader etiqueta así la lectura de `pasajeros_parada` y esas filas SON los abordajes;
 * "abordajes" se contempla por si esa etiqueta llega a separarse.
 */
const PIEZAS_EVIDENCIA: readonly string[] = ["paradas", "abordajes", "roster", "gps", "eventos"];

/** Las piezas de las que sale el veredicto DOCUMENTAL (apto / no apto para salir). */
const PIEZAS_DOCUMENTALES: readonly string[] = ["docs_unidad", "conductor", "empresa"];

/**
 * El ÚNICO nivel que ACUSA: afirma una ausencia como si fuera un hecho observado. Los demás o
 * describen evidencia encontrada (`salio`, `operado_sin_hora`) o no opinan (`por_salir`, `na`),
 * y esos no se degradan: la evidencia hallada sigue siendo evidencia aunque falte otra pieza.
 */
const esVeredictoAcusatorio = (n: NivelSalida) => n === "no_arranco";

// ══════════════════════════════════════════════════════════════════════════════
// PIEZAS PEQUEÑAS
// ══════════════════════════════════════════════════════════════════════════════

function Pastilla({ texto, color, bg, titulo }: { texto: string; color: string; bg: string; titulo?: string }) {
  return (
    <span title={titulo} className="text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ color, background: bg }}>{texto}</span>
  );
}

/**
 * Desviación contra la hora prevista. Umbrales: gris ≤5 min (ruido operativo normal),
 * ámbar 6-20, rojo >20. No se pinta nada si falta alguna de las dos horas: un hueco
 * honesto vale más que un "0 min" inventado.
 */
function Desviacion({ min }: { min: number | null }) {
  if (min === null || !Number.isFinite(min)) return null;
  const a = Math.abs(min);
  const c = a <= 5 ? { color: "#6b7280", bg: "#f3f4f6" }
    : a <= 20 ? { color: "#b45309", bg: "#fffbeb" }
      : { color: "#dc2626", bg: "#fef2f2" };
  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md font-mono whitespace-nowrap"
      style={{ color: c.color, background: c.bg }}>
      {min === 0 ? "en punto" : `${min > 0 ? "+" : "-"}${a} min`}
    </span>
  );
}

/** Sección con título. Sin hijos NO se pinta: un título vacío es ruido. */
function Seccion({ titulo, icono, extra, children }: {
  titulo: string; icono?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="mb-3">
      <div className="flex items-center justify-between px-1 mb-1.5">
        <div className="flex items-center gap-1.5">
          {icono}
          <h3 className={ETIQUETA}>{titulo}</h3>
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** Bloque plegable. `abierto` es solo el estado INICIAL (lo verde nace cerrado). */
function Plegable({ resumen, abierto = false, children }: {
  resumen: React.ReactNode; abierto?: boolean; children: React.ReactNode;
}) {
  const [ver, setVer] = useState(abierto);
  return (
    <div>
      <button onClick={() => setVer(v => !v)} aria-expanded={ver}
        className={`w-full flex items-center justify-between gap-2 text-left ${FOCO} rounded-lg`}>
        <span className="min-w-0 flex-1">{resumen}</span>
        <I.ChevronDown size={14} className={`text-gray-300 flex-shrink-0 transition-transform ${ver ? "rotate-180" : ""}`} />
      </button>
      {ver && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Tarjeta de hallazgo de la sección "Requiere atención". */
function Hallazgo({ tono, titulo, detalle, icono }: {
  tono: "rojo" | "ambar"; titulo: string; detalle?: React.ReactNode; icono?: React.ReactNode;
}) {
  const c = tono === "rojo"
    ? { bg: "bg-red-50", borde: "border-red-200", txt: "text-red-700", sub: "text-red-600" }
    : { bg: "bg-amber-50", borde: "border-amber-200", txt: "text-amber-800", sub: "text-amber-700" };
  return (
    <div className={`${c.bg} border ${c.borde} rounded-2xl px-3 py-2.5 flex items-start gap-2.5`}>
      <span className="mt-0.5 flex-shrink-0">{icono}</span>
      <div className="min-w-0">
        <p className={`text-[12px] font-bold leading-snug ${c.txt}`}>{titulo}</p>
        {detalle && <div className={`text-[11px] mt-1 leading-snug ${c.sub}`}>{detalle}</div>}
      </div>
    </div>
  );
}

/**
 * ESTADO NEUTRO: la lectura falló, así que aquí no se afirma nada.
 *
 * Es lo que se pinta en lugar de un veredicto cuando `fallos` toca una pieza de la que dependía
 * ese veredicto. No es rojo (no acusa) ni verde (no absuelve): es gris, dice QUÉ no se pudo leer
 * y ofrece la única acción sensata, volver a intentarlo. Un ERP que no sabe tiene que decir que
 * no sabe; lo que no puede es acusar a un servicio de no haber salido porque una consulta se cayó.
 */
function DatosIlegibles({ titulo = "No se pudieron leer los datos del servicio", detalle, onReintentar }: {
  titulo?: string; detalle: string; onReintentar: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex-shrink-0"><I.Alert size={14} color="#64748b" /></span>
      <div className="min-w-0">
        <p className="text-[12px] font-bold text-gray-600 leading-snug">{titulo}</p>
        <p className="text-[11px] text-gray-500 leading-snug mt-1">
          Falló la lectura de {detalle}. Esta ficha <b>no afirma nada</b> sobre lo que falta: un contador
          en cero sería un dato que no llegó, no un hecho.
        </p>
        <button onClick={onReintentar}
          className={`mt-2 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors ${FOCO}`}>
          Reintentar carga
        </button>
      </div>
    </div>
  );
}

/** Par etiqueta / valor de una línea. */
function Dato({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-gray-400 font-semibold flex-shrink-0">{k}</span>
      <span className={`text-[12px] text-gray-700 font-semibold text-right min-w-0 truncate ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// LÍNEA DE TIEMPO
// ══════════════════════════════════════════════════════════════════════════════

/** La hora de un instante. Estimada ⇒ CURSIVA y "~": marca que NO se debe facturar. */
function Hora({ inst }: { inst: Instante | null }) {
  if (!inst) return <span className="font-mono text-[13px] text-gray-300">—</span>;
  return (
    <span className={`font-mono text-[13px] font-bold ${inst.estimado ? "italic text-gray-500" : "text-[#0b315f]"}`}>
      {inst.estimado ? "~" : ""}{inst.hhmm}
    </span>
  );
}

function FilaTiempo({ f }: { f: FilaLinea }) {
  const hay = !!f.instante;
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <div className="w-[52px] flex-shrink-0 text-right pt-0.5"><Hora inst={f.instante} /></div>
      <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${hay ? (f.instante!.estimado ? "bg-gray-300" : "bg-[#16a34a]") : "bg-gray-200"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-[12px] font-bold ${hay ? "text-gray-800" : "text-gray-400"}`}>{f.etiqueta}</span>
          <Desviacion min={f.desviacionMin} />
          {f.previstaHhmm && (
            <span className="text-[10px] text-gray-400 font-mono">prev. {f.previstaHhmm}</span>
          )}
        </div>
        {/* PROCEDENCIA: de dónde salió la hora. Sin esto una hora del GPS y una marcada por
            el conductor se leen igual, y no son el mismo hecho ni valen lo mismo. */}
        {hay && <p className="text-[10.5px] text-gray-400 leading-snug mt-0.5">{procedencia(f.instante)}</p>}
        {f.nota && <p className="text-[10.5px] text-gray-400 italic leading-snug mt-0.5">{f.nota}</p>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPONENTE
// ══════════════════════════════════════════════════════════════════════════════

export default function FichaServicio({
  s, onClose, onRefresh, onGps, empresaPerfil, esAdmin, children,
}: {
  /** El ServicioView de app/seguimiento/page.tsx. Tipado LAXO a propósito: ese tipo no
   *  está exportado y acoplar este componente a un archivo que otra sesión está editando
   *  sería pelear por el mismo fichero. */
  s: any;
  onClose: () => void;
  onRefresh: () => void;
  onGps: (s: any) => void;
  empresaPerfil: { nombre: string | null; logo_url: string | null; telefono: string | null; email: string | null } | null;
  esAdmin?: boolean;
  /** La tarjeta clásica (gastos, checklist, reemplazo, teléfono). Ver sección 8. */
  children?: React.ReactNode;
}) {
  const r = s?.reserva ?? null;
  const rid: number | undefined = r?.id;

  const [datos, setDatos] = useState<FichaDatos | null>(null);
  const [fase, setFase] = useState<"cargando" | "listo" | "error">("cargando");
  /** Rol del usuario, solo si el llamador NO decidió por su cuenta. Se resuelve aquí y no en
   *  /seguimiento para no añadir estado a un archivo que otra sesión está editando. Ante la duda
   *  (sesión ausente, consulta fallida) queda en false: la cifra comercial se OCULTA por defecto,
   *  que es el lado seguro de equivocarse. */
  const [adminDetectado, setAdminDetectado] = useState(false);
  const verEconomia = esAdmin ?? adminDetectado;
  useEffect(() => {
    if (esAdmin !== undefined) return;
    let vivo = true;
    (async () => {
      try {
        const { data: ses } = await supabase.auth.getSession();
        const uid = ses?.session?.user?.id;
        if (!uid) return;
        const { data } = await supabase.from("usuarios").select("rol").eq("id", uid).maybeSingle();
        if (vivo) setAdminDetectado((data as any)?.rol === "admin");
      } catch { /* sin rol → sin cifras comerciales */ }
    })();
    return () => { vivo = false; };
  }, [esAdmin]);
  /** Reloj CONGELADO al abrir. Si se leyera Date.now() en cada render, la línea de tiempo
   *  cambiaría de veredicto sola mientras el operador la mira. */
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now());
  const [horaManual, setHoraManual] = useState("");
  const [guardando, setGuardando] = useState(false);
  /** Contador de reintentos: cambiarlo relanza la carga. Es la acción que acompaña al estado
   *  neutro — si la ficha no puede afirmar nada porque una lectura falló, lo mínimo es dejar
   *  volver a pedirla sin cerrar y reabrir el drawer. */
  const [intento, setIntento] = useState(0);
  const reintentar = useCallback(() => setIntento(n => n + 1), []);

  // ── ESC cierra (réplica del useEffect del drawer anterior) ───────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // ── Carga LAZY, con cancelación ──────────────────────────────────────────────
  // Nada de cargar en el render: al cambiar de servicio (o al remontar) la respuesta vieja
  // podría llegar después de la nueva y pintar el servicio equivocado. El flag `vivo` corta.
  useEffect(() => {
    if (!r) return;
    let vivo = true;
    setFase("cargando"); setDatos(null); setHoraManual(""); setAhoraMs(Date.now());
    cargarFichaDatos(r, { paradaIds: (s?.paradas || []).map((p: any) => p?.id).filter(Boolean) })
      .then(d => { if (vivo) { setDatos(d); setFase("listo"); } })
      .catch(() => { if (vivo) setFase("error"); });
    return () => { vivo = false; };
    // `s.pasajeros_total_real` entra en las dependencias como en el DocBar anterior: si el
    // lote diario refresca el conteo de pasajeros, el roster de la ficha se reconstruye.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, s?.pasajeros_total_real, intento]);

  // ── Motores puros ────────────────────────────────────────────────────────────
  // Solo se ejecutan con `datos` ya cargados: llamarlos con listas vacías durante la carga
  // devolvería "no arrancó" para un servicio que sí operó — el falso positivo rojo que este
  // rediseño existe para borrar.
  const tiempos: TiemposServicio | null = useMemo(() => {
    if (!r || !datos) return null;
    return derivarTiempos({
      reserva: r,
      paradas: datos.paradas,
      abordajes: datos.abordajes,
      eventos: datos.eventos,
      gps: datos.gps,
      ahoraMs,
    });
  }, [r, datos, ahoraMs]);

  const aptitud: AptitudServicio | null = useMemo(() => {
    if (!r || !datos) return null;
    const uniId = datos.esTer ? r.vehiculo_tercero_id : r.vehiculo_id;
    const placa = s?.vehiculo_placa && s.vehiculo_placa !== "—" ? s.vehiculo_placa : null;
    return evaluarAptitud({
      fechaServicio: r.fecha_servicio ?? "",
      unidad: uniId != null ? { id: Number(uniId), placa, tercerizada: datos.esTer } : null,
      // SIN pre-filtrar por placa: el filtro `vehiculo_id IS NULL OR = unidad.id` lo aplica
      // el motor (lib/documentos-estado.ts:637). Filtrarlo aquí fuera es donde se olvidó.
      docsUnidad: datos.docsUnidad,
      conductor: datos.docsConductor,
      empresa: datos.docsEmpresa,
    });
  }, [r, datos, s?.vehiculo_placa]);

  // ── Roster ordenado para la sección 3 ────────────────────────────────────────
  // Estos dos useMemo viven AQUÍ ARRIBA, con el resto de hooks y ANTES del `return`
  // temprano de más abajo: un hook llamado después de un return condicional cambia el
  // ORDEN de hooks entre renders y React lanza. (Estaban junto al bloque que los usa y
  // el lint de rules-of-hooks lo cazó; se dejan aquí y su uso queda unas líneas más lejos.)
  // `orden` es 1-BASED (app/programacion/page.tsx:740 escribe `orden: i + 1`), así que sumarle 1
  // otra vez bautizaba "Paradero 2" a la primera parada sin nombre. El índice `i` sí es 0-based y
  // ese es el único que lleva el +1. Misma fórmula que `imprimirReporte`, que ya lo hacía bien.
  const nombreParada = useMemo(() => {
    const m = new Map<number, string>();
    (datos?.paradas || []).forEach((p, i) => m.set(Number(p.id), p.nombre || `Paradero ${Number(p.orden ?? i + 1)}`));
    return m;
  }, [datos?.paradas]);

  const rosterOrdenado = useMemo(() => {
    // Abordados primero (por hora), luego pendientes, y al final los "No Show" y
    // cancelados. NO se ocultan: un pasajero que no subió es justo el que hay que ver.
    const rango = (x: any) => esAbordado(x) ? 0 : esCancelado(x) ? 3 : esNoShow(x) ? 2 : 1;
    return (datos?.roster ?? []).slice().sort((a: any, b: any) => {
      const d = rango(a) - rango(b);
      if (d !== 0) return d;
      const ha = a.hora_abordaje ? Date.parse(a.hora_abordaje) : Infinity;
      const hb = b.hora_abordaje ? Date.parse(b.hora_abordaje) : Infinity;
      if (ha !== hb) return ha - hb;
      return String(a.pasajero?.nombre || "").localeCompare(String(b.pasajero?.nombre || ""));
    });
  }, [datos?.roster]);

  // ── Escrituras (las únicas de este componente) ───────────────────────────────

  /**
   * Registro MANUAL de la hora de salida. Solo se ofrece cuando el motor confirma que no
   * hay ninguna evidencia de la que derivarla (`puedeRegistrarInicioManual`): si el sistema
   * ya sabe la hora, un campo editable al lado solo sirve para que alguien la contradiga.
   * Se escribe en `reservas.hora_real_inicio`, que el motor lee como fuente "operador" y
   * pinta como "registrado por operación". Ninguna hora DERIVADA se persiste jamás.
   */
  const guardarHoraManual = useCallback(async () => {
    if (!rid || !/^\d{2}:\d{2}$/.test(horaManual)) return;
    setGuardando(true);
    const { error } = await supabase.from("reservas")
      .update({ hora_real_inicio: `${horaManual}:00` }).eq("id", rid);
    setGuardando(false);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, horaManual, onRefresh]);

  /** Viáticos: el ÚNICO flag manual que sobrevive al rediseño. Describe un hecho físico
   *  (se entregó efectivo en mano) que el ERP no puede observar por ningún otro medio. */
  const alternarViaticos = useCallback(async () => {
    if (!rid) return;
    const { error } = await supabase.from("reservas")
      .update({ viaticos_entregados: !r?.viaticos_entregados }).eq("id", rid);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, r?.viaticos_entregados, onRefresh]);

  /** Arranca la dimensión B (cierre administrativo). Es el mismo puente que ya dispara el
   *  guardado de horas del drawer clásico (page.tsx:545); aquí solo se hace explícito para
   *  los servicios finalizados que se quedaron sin él. */
  const pasarALiquidacion = useCallback(async () => {
    if (!rid) return;
    const { error } = await supabase.from("reservas")
      .update({ estado_admin: ESTADO_ADMIN_INICIAL }).eq("id", rid);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, onRefresh]);

  if (!r) return null;

  // ── Datos de cabecera ────────────────────────────────────────────────────────
  // `normalizaEstado` UNA sola vez, y TODAS las comparaciones de estado de este archivo salen de
  // aquí. Comparar contra el valor crudo (`r.estado === "finalizada"`) deja fuera los legados que
  // lib/estados.ts sí contempla ('finalizado', 'completada', 'realizada', 'cancelado'): con ellos
  // el drawer habilitaba el Manifiesto MTC de un servicio CANCELADO y escondía el Reporte y el
  // "Marcar Por liquidar" de uno finalizado. Si aparece un estado nuevo, se añade en estados.ts.
  const estado = normalizaEstado(r.estado);
  const estadoOp = ESTADOS_RESERVA[estado];
  const estadoAdminClave: string | null = (r as any).estado_admin ?? null;
  const cfgAdmin = estadoAdminClave ? (ESTADOS_ADMIN as any)[estadoAdminClave] : null;
  const sentido: string | null = (r as any).direccion_servicio ?? null;
  const placa: string | null = s?.vehiculo_placa && s.vehiculo_placa !== "—" ? s.vehiculo_placa : null;
  const cancelado = estado === "cancelada";
  const finalizado = estado === "finalizada";
  const enCurso = estado === "en_curso";

  // ── QUÉ NO SE PUDO LEER (se calcula ANTES que ningún veredicto, a propósito) ──
  const cargando = fase === "cargando";
  const fallos = datos?.fallos ?? [];
  const textoFallos = (lista: string[]) => lista.map(f => NOMBRE_FALLO[f] || f).join(", ");
  const fallosEvidencia = fallos.filter(f => PIEZAS_EVIDENCIA.includes(f));
  /** O se cayó la carga entera, o se cayó alguna pieza de las que alimentan el veredicto. */
  const evidenciaIlegible = fase === "error" || fallosEvidencia.length > 0;
  const detalleIlegible = fase === "error"
    ? "el detalle del servicio (horas reales, pasajeros y documentos)"
    : textoFallos(fallosEvidencia);
  /** Roster y abordajes salen de la MISMA lectura: si falla, "0 pasajeros" no es un cero. */
  const rosterIlegible = fase === "error" || fallos.includes("roster") || fallos.includes("abordajes");
  const fallosDoc = fallos.filter(f => PIEZAS_DOCUMENTALES.includes(f));

  // Chip del veredicto de salida. El texto cambia según el nivel; el COLOR sale de
  // NIVEL_SALIDA, donde "operó sin hora" es GRIS y nunca rojo (esa confusión es el bug).
  const nivelMotor: NivelSalida = tiempos?.veredicto.nivel ?? "na";
  /** LA COMPROBACIÓN DEL CONTRATO. El motor recibió listas vacías y no sabe si están vacías
   *  porque no hay nada o porque la consulta se cayó; aquí sí se sabe, así que su única
   *  acusación (`no_arranco`) se degrada a "—" gris y el drawer pasa a decir que no sabe. */
  const veredictoDegradado = evidenciaIlegible && esVeredictoAcusatorio(nivelMotor);
  const nivel: NivelSalida = veredictoDegradado ? "na" : nivelMotor;
  const cfgNivel = NIVEL_SALIDA[nivel];
  const sinVeredicto = veredictoDegradado || fase === "error";
  const textoVeredicto = (() => {
    if (sinVeredicto) return "Sin datos";
    if (!tiempos) return "—";
    const i = tiempos.veredicto.instante;
    if (nivel === "salio" && i) return enCurso ? `En ruta desde ${i.hhmm}` : `Salió ${i.hhmm}`;
    if (nivel === "por_salir") return `Por salir ${r.hora_servicio?.slice(0, 5) || ""}`.trim();
    return cfgNivel.label;
  })();
  const tituloVeredicto = sinVeredicto
    ? `No se pudo leer ${detalleIlegible}. La ficha no afirma si el servicio salió.`
    : (tiempos?.veredicto.motivo || "");

  // ── Sección 1 · hallazgos que exigen actuar ──────────────────────────────────
  const bloqueantes: HallazgoDoc[] = aptitud?.bloqueantes ?? [];
  const avisosDoc: HallazgoDoc[] = aptitud?.avisos ?? [];
  const hayAtencion =
    bloqueantes.length > 0 || avisosDoc.length > 0 || fallos.length > 0 ||
    !!r.unidad_reemplazo_placa || !!s?.conflicto_vehiculo || !!s?.conflicto_conductor || !!s?.jornada_extensa;

  // ── Sección 3 · contadores del roster (el orden se calculó arriba, con los hooks) ──
  const roster: DocPasajero[] = datos?.roster ?? [];
  const abordaron = roster.filter(x => esAbordado(x)).length;
  const esperados = roster.length;
  const rosterOk = esperados > 0 && abordaron === esperados;

  // ── Sección 6 · documentos imprimibles ───────────────────────────────────────
  const servicioBase = {
    // Las paradas mandan sobre r.origen/r.destino (copia denormalizada que se desfasa).
    fecha: r.fecha_servicio, hora: r.hora_servicio,
    origen: (datos?.paradas?.[0]?.nombre) ?? s?.paradas?.[0]?.nombre ?? r.origen ?? "",
    destino: (datos && datos.paradas.length > 1 ? datos.paradas[datos.paradas.length - 1].nombre : null)
      ?? r.destino ?? "",
  };

  function imprimirManifiesto() {
    if (!datos) return;
    abrirImprimible(manifiestoMtcHTML({
      empresa: { logoUrl: empresaPerfil?.logo_url ?? null },
      cliente: { nombre: s?.cliente_nombre },
      servicio: servicioBase,
      conductor: datos.conductor ? { nombre: datos.conductor.nombre, licencia: datos.conductor.licencia } : null,
      vehiculo: { placa },
      pasajeros: datos.roster,
      boarding: [],
    }));
  }

  function imprimirReporte() {
    if (!datos || !tiempos) return;
    // EL CAMBIO DE FONDO DEL REPORTE: antes imprimía `reservas.hora_real_inicio/fin`, o sea
    // casi siempre nada (1 de 575 / 0 de 575 en 30 días) y con la duración tapada por un
    // `Math.max(0, …)` que convertía un servicio 22:00→01:30 en "0 min". Ahora imprime la
    // hora DERIVADA **con su procedencia**, que es lo que la hace auditable: quien lea el
    // PDF sabe si esa hora la marcó el conductor o la estimó el GPS.
    const ini = tiempos.inicio;
    const fin = tiempos.fin;
    const hayOp = !!(ini || fin || (s?.gastos_total || 0) > 0);
    const finTexto = fin
      ? procedencia(fin) + (tiempos.mostrarAmbosFines && tiempos.finParadero
        ? ` · último paradero ${tiempos.finParadero.hhmm}` : "")
      : null;
    abrirImprimible(reporteServicioHTML({
      empresa: {
        nombre: empresaPerfil?.nombre ?? null,
        telefono: empresaPerfil?.telefono ?? null,
        email: empresaPerfil?.email ?? null,
        logoReporteUrl: window.location.origin + "/logoafacotizacion-removebg-preview.png",
        firmaUrl: window.location.origin + "/firmaJLCA.png",
      },
      cliente: { nombre: s?.cliente_nombre, ruc: datos.clienteRuc },
      servicio: servicioBase,
      paradas: datos.paradas.map((p, i) => ({
        id: Number(p.id), orden: Number(p.orden ?? i + 1),
        nombre: p.nombre || `Paradero ${Number(p.orden ?? i + 1)}`,
        hora_estimada: p.hora_estimada ?? null,
      })),
      pasajeros: datos.roster,
      boarding: [],
      operativo: hayOp ? {
        horaRealInicio: ini ? procedencia(ini) : null,
        horaRealFin: finTexto,
        duracionMin: tiempos.duracionMin,
        gastosTotal: s?.gastos_total ?? null,
        gpsUrl: null,
      } : null,
    }));
  }

  // El Manifiesto MTC es un documento LEGAL: no se imprime con un roster que quizá esté vacío
  // solo porque la consulta se cayó. "Sin pasajeros" y "no pude leer los pasajeros" bloquean
  // igual, pero el motivo que se enseña no es el mismo y el segundo tiene arreglo (reintentar).
  const motivoManifiesto = cargando ? "Cargando la lista de pasajeros…"
    : cancelado ? "Servicio cancelado: no se emite Manifiesto MTC"
      : esperados === 0
        ? (rosterIlegible
          ? "No se pudo leer la lista de pasajeros: reintenta la carga antes de imprimir"
          : "Sin pasajeros en el manifiesto")
        : null;
  const motivoReporte = cargando ? "Cargando los datos del servicio…"
    : !(enCurso || finalizado)
      ? "Disponible cuando el servicio está en curso o finalizado"
      : null;

  const btn = `flex items-center gap-1.5 text-[11.5px] font-bold px-3 py-2 rounded-xl transition-colors ${FOCO} disabled:opacity-40 disabled:cursor-not-allowed`;

  // ══════════════════════════════════════════════════════════════════════════════
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose}
        role="button" tabIndex={-1} aria-label="Cerrar la ficha del servicio" />

      <div role="dialog" aria-modal="true" aria-label={`Ficha del servicio ${idAfa(r)}`}
        className="relative h-full w-full max-w-lg bg-[#eef3f8] shadow-2xl flex flex-col">

        {/* ══ 0 · CABECERA FIJA ══════════════════════════════════════════════════
            ÚNICO sitio de todo el drawer donde aparecen estado, folio y cliente. El
            estado ADMINISTRATIVO (reservas.estado_admin) se muestra por primera vez: el
            drawer anterior lo ESCRIBÍA al finalizar y nunca lo enseñaba. */}
        <header className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Pastilla texto={estadoOp.label} color={estadoOp.color} bg={estadoOp.bg} />
                {cfgAdmin && (
                  <Pastilla texto={cfgAdmin.label} color="#ffffff" bg={cfgAdmin.color}
                    titulo={`Cierre administrativo: ${cfgAdmin.descripcion}`} />
                )}
                <span className="font-black text-[#0b315f] text-[13px]">{idAfa(r)}</span>
                {sentido && (
                  <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#1d4ed8] uppercase">
                    {sentido === "retorno" ? "Retorno" : sentido === "ida" ? "Ida" : sentido}
                  </span>
                )}
              </div>
              <p className="text-[12.5px] font-bold text-gray-700 truncate mt-1">{s?.cliente_nombre || "Sin cliente"}</p>
              <div className="flex items-center gap-2 text-[11px] text-gray-500 mt-0.5 flex-wrap">
                <span className="font-mono font-bold text-gray-400">{placa || "sin unidad"}</span>
                <span className="text-gray-200">·</span>
                <span className="truncate">{datos?.conductor?.nombre || s?.conductor_nombre || "sin conductor"}</span>
                <span className="text-gray-200">·</span>
                <span className="font-mono">{fechaDMY(r.fecha_servicio)} {r.hora_servicio?.slice(0, 5) || ""}</span>
              </div>
            </div>

            <div className="flex flex-col items-end gap-2 flex-shrink-0">
              <button onClick={onClose} aria-label="Cerrar"
                className={`w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center ${FOCO}`}>
                <I.X size={15} />
              </button>
              {/* MIENTRAS CARGA NO SE PINTA VEREDICTO. Con `datos` todavía en null el nivel
                  cae a "na", pero un esqueleto es más honesto que un guion: nada de enseñar
                  un dictamen calculado sobre listas que aún no han llegado. */}
              {cargando ? (
                <span className="h-[22px] w-[86px] rounded-full bg-gray-100 animate-pulse"
                  role="status" aria-label="Calculando el veredicto de salida" />
              ) : (
                <span className="text-[10.5px] font-black px-2.5 py-1 rounded-full whitespace-nowrap"
                  style={{ color: cfgNivel.color, background: cfgNivel.bg }}
                  title={tituloVeredicto}>
                  {textoVeredicto}
                </span>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-3">

          {/* CARGA CAÍDA ENTERA. La sección 1 no se pinta en este estado (exige fase "listo"),
              así que el aviso y el botón de reintentar viven aquí. */}
          {fase === "error" && (
            <div className={`${TARJETA} p-3 mb-3`}>
              <DatosIlegibles detalle={detalleIlegible} onReintentar={reintentar} />
              <p className="text-[10.5px] text-gray-400 leading-snug mt-2">
                La cabecera es correcta; lo que no llegó es el detalle. Si vuelve a fallar, revisa la conexión.
              </p>
            </div>
          )}

          {/* ══ 1 · REQUIERE ATENCIÓN ═══════════════════════════════════════════
              Si no hay nada, esta sección NO EXISTE. Ni título vacío ni un "todo ok"
              que hay que leer todos los días para descubrir que no dice nada. */}
          {fase === "listo" && hayAtencion && (
            /* NO se repite aquí `s.seguro_vence_hoy` ni `s.docs_vencidos`, que el tablero
               calcula con `diasPara(...) ?? 1` contra HOY. evaluarAptitud() responde la misma
               pregunta mejor (contra la FECHA DEL SERVICIO, con la lista de obligatorios y con
               el filtro por placa de los terceros): duplicarlas daría dos avisos del mismo
               documento, a veces contradictorios. */
            <Seccion titulo="Requiere atención" icono={<I.Alert size={12} color="#dc2626" />}>
              <div className="space-y-2">
                {/* Lo que IMPIDE salir. `bloquea` lo decide el motor; aquí no se replica
                    la regla, se lee el campo. */}
                {bloqueantes.map((h, i) => (
                  <Hallazgo key={`b${i}`} tono="rojo" icono={<I.Shield size={14} color="#b91c1c" />}
                    titulo={h.texto}
                    detalle={<span>No despachar: {h.sujeto === "unidad" ? "documento de la unidad" : h.sujeto === "conductor" ? "documento del conductor" : "situación del proveedor"} · medido contra el {fechaDMY(r.fecha_servicio)}</span>} />
                ))}

                {/* Avisos documentales: ÁMBAR y NO bloquean (decisión del dueño). Se
                    resumen aquí y el detalle documento a documento vive en la sección 4. */}
                {avisosDoc.length > 0 && (
                  <Hallazgo tono="ambar" icono={<I.FileText size={14} color="#b45309" />}
                    titulo={aptitud!.apto ? aptitud!.resumen : `${avisosDoc.length} aviso${avisosDoc.length === 1 ? "" : "s"} documental${avisosDoc.length === 1 ? "" : "es"}`}
                    detalle={
                      <ul className="space-y-0.5">
                        {avisosDoc.slice(0, 3).map((h, i) => <li key={i}>· {h.texto}</li>)}
                        {avisosDoc.length > 3 && <li className="italic">· y {avisosDoc.length - 3} más — ver “Unidad, conductor y cumplimiento”</li>}
                      </ul>
                    } />
                )}

                {r.unidad_reemplazo_placa && (
                  <Hallazgo tono="ambar" icono={<I.Swap size={14} color="#b45309" />}
                    titulo={`Unidad de reemplazo: ${r.unidad_reemplazo_placa}`}
                    detalle={`Programada ${placa || "sin unidad"}${r.reemplazo_motivo ? ` · motivo: ${r.reemplazo_motivo}` : " · sin motivo registrado"}. Verificar que la facturación al cliente use la unidad real.`} />
                )}

                {/* Alertas cruzadas que YA trae el servicio (las calcula el tablero sobre
                    todos los servicios del día). Son heurísticas — se dicen como tales. */}
                {s?.conflicto_vehiculo && (
                  <Hallazgo tono="ambar" icono={<I.Bus size={14} color="#b45309" />}
                    titulo="Posible solape de unidad"
                    detalle="El vehículo aparece en otro servicio a la misma hora. Es una advertencia calculada sobre las horas programadas, no una certeza: confírmalo antes de mover nada." />
                )}
                {s?.conflicto_conductor && (
                  <Hallazgo tono="ambar" icono={<I.Users size={14} color="#b45309" />}
                    titulo="Posible solape de conductor"
                    detalle="El conductor aparece en otro servicio a la misma hora." />
                )}
                {s?.jornada_extensa && (
                  <Hallazgo tono="ambar" icono={<I.Clock size={14} color="#b45309" />}
                    titulo="Jornada extensa del conductor"
                    detalle="Demasiadas horas entre la primera salida y el último fin del día, o demasiados servicios. Riesgo de fatiga." />
                )}

                {/* Datos que no se pudieron leer. Decirlo es obligatorio: un cero que no es
                    un cero es peor que un hueco. */}
                {fallos.length > 0 && (
                  <Hallazgo tono="ambar" icono={<I.Alert size={14} color="#b45309" />}
                    titulo={evidenciaIlegible
                      ? "No se pudieron leer los datos del servicio"
                      : "Ficha incompleta: falta información"}
                    detalle={
                      <div>
                        <p>No se pudo leer {textoFallos(fallos)}.</p>
                        <p className="mt-1">
                          {evidenciaIlegible
                            /* Se dice explícitamente qué se ha dejado de afirmar. Sin esta frase el
                               operador ve un chip gris y no sabe si el servicio no salió o si el
                               drawer se calló por prudencia. */
                            ? <>Falta parte de la evidencia de la que sale el veredicto, así que esta ficha <b>no afirma</b> si el servicio salió o no. Lo que veas abajo es parcial: un contador en cero sería un dato que no llegó, no un hecho.</>
                            : <>Lo que se muestra abajo es parcial: no lo tomes como un dato en cero.</>}
                        </p>
                        <button onClick={reintentar}
                          className={`mt-2 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors ${FOCO}`}>
                          Reintentar carga
                        </button>
                      </div>
                    } />
                )}
              </div>
            </Seccion>
          )}

          {/* ══ 2 · EJECUCIÓN · LÍNEA DE TIEMPO REAL ════════════════════════════
              El corazón del rediseño. Sustituye a la métrica CHECK-IN, a las dos barras
              de progreso (que repetían lo mismo con otra forma) y a los dos <input
              type="time"> que llevaban un mes vacíos. */}
          <Seccion titulo="Ejecución · línea de tiempo real" icono={<I.Clock size={12} color="#0b315f" />}
            extra={!cargando && datos && (
              <span className="text-[10px] text-gray-400 font-mono">
                {/* "sin GPS" es una AFIRMACIÓN; si la lectura del rastro falló no se puede hacer
                    (ni tampoco dar el conteo por bueno, que en esa rama puede venir a la baja). */}
                {/* `gpsTotal === null` es el "no lo sé" del loader (invariante suya: null ⇒ "gps"
                    está en `fallos`). Ni conteo ni "sin GPS": las dos serían afirmaciones. */}
                {datos.gpsTotal === null || fallos.includes("gps")
                  ? "GPS no leído"
                  : datos.gpsTotal > 0
                    ? `${datos.gpsTotal.toLocaleString("es-PE")} punto${datos.gpsTotal === 1 ? "" : "s"} GPS${datos.gpsTruncado ? "+" : ""}`
                    : "sin GPS"}
              </span>
            )}>
            <div className={`${TARJETA} p-3`}>
              {cargando && (
                /* ESQUELETO, no veredicto: mientras `datos` es null el motor ni se ejecuta. */
                <div className="py-2 space-y-2" role="status" aria-label="Cargando el horario real">
                  <div className="h-3 w-2/3 rounded bg-gray-100 animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-gray-100 animate-pulse" />
                  <div className="h-3 w-3/5 rounded bg-gray-100 animate-pulse" />
                </div>
              )}

              {!cargando && !tiempos && (
                fase === "error"
                  ? <DatosIlegibles detalle={detalleIlegible} onReintentar={reintentar} />
                  : <p className="text-[12px] text-gray-400 py-3 text-center">Sin datos suficientes para reconstruir el horario.</p>
              )}

              {/* Línea vacía = servicio cancelado (único caso que devuelve SIN_TIEMPOS). */}
              {tiempos && tiempos.linea.length === 0 && (
                <p className="text-[12px] text-gray-500 py-2">{tiempos.veredicto.motivo}</p>
              )}

              {tiempos && tiempos.linea.length > 0 && (
                <>
                  <div className="divide-y divide-gray-50">
                    {tiempos.linea.map(f => <FilaTiempo key={f.clave} f={f} />)}
                  </div>

                  {/* LOS DOS FINES. Un bus que descarga al último pasajero 18:40 y cierra la
                      app 19:25 en la cochera tiene las dos horas bien; cobrar la segunda es
                      cobrar el retorno a cochera. Solo se despliegan si la brecha lo amerita. */}
                  {tiempos.mostrarAmbosFines && (
                    <div className="mt-2 pt-2 border-t border-gray-100 bg-amber-50/60 -mx-3 -mb-3 px-3 py-2.5 rounded-b-2xl">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 mb-1.5">El fin son dos horas distintas</p>
                      <div className="flex items-center justify-between gap-2 py-0.5">
                        <span className="text-[11.5px] font-bold text-gray-700">Último paradero <span className="font-normal text-gray-400">· la que factura</span></span>
                        <Hora inst={tiempos.finParadero} />
                      </div>
                      <div className="flex items-center justify-between gap-2 py-0.5">
                        <span className="text-[11.5px] font-bold text-gray-700">Cierre del conductor <span className="font-normal text-gray-400">· la operativa</span></span>
                        <Hora inst={tiempos.finCierre} />
                      </div>
                      {tiempos.finParadero && tiempos.finCierre && (
                        <p className="text-[10.5px] text-amber-700 mt-1 leading-snug">
                          {formatoDuracion(Math.abs(Math.round((tiempos.finCierre.ts - tiempos.finParadero.ts) / 60000)))}
                          {tiempos.finCierre.ts >= tiempos.finParadero.ts ? " después" : " antes"} del último paradero.
                        </p>
                      )}
                    </div>
                  )}

                  {/* DURACIÓN REAL vs PREVISTA. La prevista se deriva de las horas estimadas
                      de la primera y la última parada: `reservas` no tiene columna de duración
                      y no se va a inventar una. Si no se puede calcular, se dice. */}
                  <div className="mt-3 pt-2.5 border-t border-gray-100 flex items-baseline justify-between gap-3">
                    <span className={ETIQUETA}>Duración real</span>
                    <div className="text-right">
                      <span className="font-mono text-[14px] font-black text-[#0b315f]">
                        {tiempos.duracionMin !== null ? formatoDuracion(tiempos.duracionMin) : "—"}
                      </span>
                      {(() => {
                        const ps = datos?.paradas || [];
                        const a = ps[0]?.hora_estimada, b = ps.length > 1 ? ps[ps.length - 1]?.hora_estimada : null;
                        const min = (h?: string | null) => {
                          if (!h) return null;
                          const [hh, mm] = String(h).slice(0, 5).split(":").map(Number);
                          return Number.isFinite(hh) ? hh * 60 + (mm || 0) : null;
                        };
                        const ma = min(a), mb = min(b);
                        if (ma === null || mb === null) {
                          return <p className="text-[10px] text-gray-400">sin duración prevista registrada</p>;
                        }
                        let prev = mb - ma; if (prev < 0) prev += 1440;
                        const dif = tiempos.duracionMin !== null ? tiempos.duracionMin - prev : null;
                        return (
                          <p className="text-[10px] text-gray-400">
                            prevista {formatoDuracion(prev)}
                            {dif !== null && ` · ${dif >= 0 ? "+" : "-"}${Math.abs(dif)} min`}
                          </p>
                        );
                      })()}
                    </div>
                  </div>
                </>
              )}

              {/* SIN NINGUNA HORA. Gris, jamás rojo: que nadie registrara la hora no
                  significa que el bus no saliera. Eso lo decide `veredicto.nivel`. */}
              {/* `linea.length > 0` excluye al servicio CANCELADO, que ya imprimió su motivo
                  arriba: sin esta condición se pintaba dos veces "servicio cancelado", la segunda
                  bajo el título "Sin hora registrada" — un reproche por no tener hora a un
                  servicio que nunca debió tenerla. (`puedeRegistrarInicioManual` ya devolvía
                  false con la línea vacía, así que no se pierde ninguna acción.) */}
              {tiempos && !tiempos.inicio && tiempos.linea.length > 0 && (
                <div className="mt-3 pt-2.5 border-t border-gray-100">
                  {veredictoDegradado ? (
                    /* El motivo del motor aquí sería la acusación en prosa ("1080 min pasada la
                       hora sin ninguna evidencia"). No se imprime: esa evidencia no se pudo leer. */
                    <DatosIlegibles detalle={detalleIlegible} onReintentar={reintentar} />
                  ) : (
                    <>
                      {/* El título distingue los dos casos: "no hay NINGUNA hora" y "hay cierre
                          pero no salida". Llamar a los dos igual sería el mismo pecado que el
                          check-in: una etiqueta que no describe lo que pasó. */}
                      <p className="text-[12px] font-bold text-gray-500">
                        {tiempos.fin ? "Sin hora de salida" : "Sin hora registrada"}
                      </p>
                      <p className="text-[11px] text-gray-400 leading-snug mt-0.5">{tiempos.veredicto.motivo}</p>
                    </>
                  )}

                  {puedeRegistrarInicioManual(tiempos) && (
                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                      <input type="time" value={horaManual} onChange={e => setHoraManual(e.target.value)}
                        aria-label="Hora real de salida"
                        className={`border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] font-bold font-mono text-[#0b315f] ${FOCO} focus:border-[#0b315f]`} />
                      <button onClick={guardarHoraManual} disabled={guardando || !/^\d{2}:\d{2}$/.test(horaManual)}
                        className={`${btn} bg-[#0b315f] hover:bg-[#1262bd] text-white`}>
                        {guardando ? "Guardando…" : "Registrar hora"}
                      </button>
                      <p className="text-[10px] text-gray-400 basis-full leading-snug">
                        Quedará marcado como <b>registrado por operación</b>, no como evidencia del viaje.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Seccion>

          {/* ══ 3 · PERSONAS · EVIDENCIA DE ABORDAJE ════════════════════════════
              Absorbe la tabla del DocBar. La diferencia: además de un ✓, se dice A QUÉ
              HORA y EN QUÉ PARADERO subió cada pasajero — dato que ya estaba en
              pasajeros_parada.hora_abordaje (reloj de SERVIDOR) y no se mostraba. */}
          <Seccion titulo="Personas · evidencia de abordaje" icono={<I.Users size={12} color="#0b315f" />}>
            <div className={`${TARJETA} p-3`}>
              {cargando ? (
                <div className="py-2 space-y-2" role="status" aria-label="Cargando la lista de pasajeros">
                  <div className="h-3 w-1/2 rounded bg-gray-100 animate-pulse" />
                  <div className="h-3 w-2/3 rounded bg-gray-100 animate-pulse" />
                </div>
              ) : esperados === 0 ? (
                // "Sin manifiesto cargado" es una AFIRMACIÓN sobre la base de datos. Solo se hace
                // cuando la lista se leyó de verdad y vino vacía; si la lectura falló, el drawer
                // dice que no pudo leerla y ofrece reintentar. (Antes lo colaba como un matiz
                // dentro del mismo título acusatorio, y ese matiz encima nunca se cumplía.)
                rosterIlegible ? (
                  <DatosIlegibles titulo="No se pudo leer la lista de pasajeros"
                    detalle={textoFallos(fallos.filter(f => f === "roster" || f === "abordajes")) || "la lista de pasajeros"}
                    onReintentar={reintentar} />
                ) : (
                  // NUNCA "0/0" en verde: un manifiesto vacío es un problema, no un éxito.
                  <div className="flex items-start gap-2">
                    <I.Alert size={14} color="#b45309" />
                    <div>
                      <p className="text-[12px] font-bold text-amber-800">Sin manifiesto cargado</p>
                      <p className="text-[11px] text-amber-700 leading-snug mt-0.5">
                        Este servicio no tiene ningún pasajero registrado.
                        Sin manifiesto no se puede emitir el documento MTC.
                      </p>
                    </div>
                  </div>
                )
              ) : (
                <>
                {/* Lectura PARCIAL: hay filas, pero también un fallo anotado. El contador se
                    enseña porque los que están son reales, con la advertencia de que el "de N"
                    puede quedarse corto — que es distinto de darlo por bueno. */}
                {rosterIlegible && (
                  <p className="text-[10.5px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 leading-snug mb-2">
                    La lista se leyó a medias ({textoFallos(fallos.filter(f => f === "roster" || f === "abordajes"))}):
                    puede faltar gente y el total de esperados quedarse corto.{" "}
                    <button onClick={reintentar} className={`font-bold underline ${FOCO} rounded`}>Reintentar carga</button>
                  </p>
                )}
                <Plegable abierto={!rosterOk}
                  resumen={
                    <div className="flex items-baseline gap-2">
                      {rosterOk && !rosterIlegible && <span className="text-green-600 font-black text-[13px]">✓</span>}
                      <span className={`text-[12.5px] font-bold ${rosterOk && !rosterIlegible ? "text-green-700" : "text-gray-700"}`}>
                        Abordaron {abordaron} de {esperados} esperado{esperados === 1 ? "" : "s"}
                      </span>
                      {!rosterOk && (
                        <span className="text-[11px] text-gray-400">
                          {esperados - abordaron} sin abordar
                        </span>
                      )}
                    </div>
                  }>
                  <ul className="divide-y divide-gray-50 max-h-72 overflow-y-auto -mx-1 px-1">
                    {rosterOrdenado.map((x: any, i: number) => {
                      const ab = esAbordado(x);
                      const noShow = esNoShow(x);
                      const canc = esCancelado(x);
                      // Date.parse() se comprueba ANTES de formatear: un `hora_abordaje` corrupto
                      // pintaría "Invalid Date" en la evidencia de abordaje de un pasajero.
                      const msAb = x.hora_abordaje ? Date.parse(x.hora_abordaje) : NaN;
                      const hora = Number.isFinite(msAb)
                        ? new Date(msAb).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false })
                        : null;
                      const par = x.parada_id != null ? nombreParada.get(Number(x.parada_id)) : null;
                      return (
                        <li key={`${x.pasajero_id}-${i}`} className="py-1.5 flex items-start gap-2">
                          <span className={`text-[11px] font-black w-4 flex-shrink-0 text-center ${ab ? "text-green-600" : canc ? "text-gray-300" : noShow ? "text-red-500" : "text-gray-300"}`}>
                            {ab ? "✓" : canc ? "–" : noShow ? "✗" : "○"}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="text-[12px] font-semibold text-gray-800 truncate">
                                {x.pasajero?.nombre || `Pasajero #${x.pasajero_id}`}
                              </span>
                              <span className="text-[10px] font-mono text-gray-400 flex-shrink-0">{x.pasajero?.dni || "sin DNI"}</span>
                            </div>
                            <p className="text-[10.5px] text-gray-400 leading-snug">
                              {ab
                                // Se dice la hora y el paradero. NO el método: pasajeros_parada
                                // no guarda cómo subió, y un "· QR" inventado es exactamente
                                // el tipo de dato decorativo que mató al check-in.
                                ? `${hora ? `${hora}` : "hora no registrada"}${par ? ` · ${par}` : ""}`
                                : canc ? "cancelado"
                                  : noShow ? "no abordó (No Show)"
                                    : par ? `pendiente · ${par}` : "pendiente · sin paradero asignado"}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Plegable>
                </>
              )}
            </div>
          </Seccion>

          {/* ══ 4 · UNIDAD, CONDUCTOR Y CUMPLIMIENTO ════════════════════════════ */}
          <Seccion titulo="Unidad, conductor y cumplimiento" icono={<I.Bus size={12} color="#0b315f" />}>
            <div className={`${TARJETA} p-3`}>
              <Dato k="Unidad" v={placa || "sin asignar"} mono />
              {r.unidad_reemplazo_placa && (
                <Dato k="Reemplazada por" v={`${r.unidad_reemplazo_placa}${r.reemplazo_motivo ? ` · ${r.reemplazo_motivo}` : ""}`} mono />
              )}
              {/* "sin asignar" / "no registrada" son AFIRMACIONES sobre la BD: no se hacen si la
                  fila del conductor no se pudo leer. */}
              <Dato k="Conductor" v={datos?.conductor?.nombre || s?.conductor_nombre
                || (cargando ? "…" : fallos.includes("conductor") ? "no se pudo leer" : "sin asignar")} />
              <Dato k="Licencia" v={datos?.conductor?.licencia
                || (cargando ? "…" : fallos.includes("conductor") ? "no se pudo leer" : "no registrada")} mono />
              {(datos?.conductor?.telefono || s?.conductor_tel) && (
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="text-[11px] text-gray-400 font-semibold">Teléfono</span>
                  <a href={`tel:${datos?.conductor?.telefono || s?.conductor_tel}`}
                    className={`text-[12px] font-mono font-bold text-[#1262bd] hover:underline flex items-center gap-1.5 ${FOCO} rounded`}>
                    <I.Phone size={11} color="#1262bd" />{datos?.conductor?.telefono || s?.conductor_tel}
                  </a>
                </div>
              )}

              <div className="mt-2.5 pt-2.5 border-t border-gray-100">
                {cargando && <p className="text-[11.5px] text-gray-400">Verificando documentos…</p>}

                {/* Sin los documentos delante no hay veredicto documental que dar: ni "conforme"
                    (absolvería sin mirar) ni una lista de "sin cargar" que parecería una BD vacía. */}
                {!cargando && fallosDoc.length > 0 && (
                  <div className="mb-2">
                    <DatosIlegibles titulo="Verificación documental incompleta"
                      detalle={textoFallos(fallosDoc)} onReintentar={reintentar} />
                  </div>
                )}

                {aptitud && aptitud.apto && aptitud.avisos.length === 0 && fallosDoc.length === 0 && (
                  // TODO CONFORME → una sola línea. Desplegable por si alguien quiere ver
                  // qué se verificó exactamente.
                  <div className="flex items-center gap-2">
                    <span className="text-green-600 font-black text-[13px]">✓</span>
                    <p className="text-[12px] font-bold text-green-700">{aptitud.resumen}</p>
                  </div>
                )}

                {aptitud && (!aptitud.apto || aptitud.avisos.length > 0) && (
                  <div>
                    <p className={`text-[12px] font-bold mb-1.5 ${aptitud.apto ? "text-amber-800" : "text-red-700"}`}>
                      {aptitud.apto ? "Con avisos documentales" : "NO APTO para salir"}
                    </p>
                    <ul className="space-y-1">
                      {[...aptitud.bloqueantes, ...aptitud.avisos].map((h, i) => {
                        const cfg = VEREDICTO_DOC_CFG[h.veredicto];
                        return (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded flex-shrink-0 mt-px"
                              style={{ color: cfg.color, background: cfg.bg }}>{cfg.corto}</span>
                            <span className={`text-[11.5px] leading-snug ${h.bloquea ? "text-red-700 font-semibold" : "text-gray-600"}`}>
                              {h.texto}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-[10px] text-gray-400 mt-2 leading-snug">
                      Medido contra la fecha del servicio ({fechaDMY(r.fecha_servicio)}), no contra hoy.
                      Un documento sin cargar avisa pero <b>no bloquea</b>; solo bloquea el que está cargado y vencido.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Seccion>

          {/* ══ 4b · OPERADOR TERCERIZADO ═══════════════════════════════════════
              La empresa y el conductor tercero son DOS entidades distintas y se muestran
              como tales: sus documentos viven en tablas diferentes y sus vencimientos no
              se cubren entre sí. */}
          {datos?.esTer && (
            <Seccion titulo="Operador tercerizado" icono={<I.Building size={12} color="#0b315f" />}>
              <div className={`${TARJETA} p-3`}>
                {datos.empresa ? (
                  <>
                    <Dato k="Empresa" v={datos.empresa.razon_social || "sin razón social"} />
                    <Dato k="RUC" v={datos.empresa.ruc || "no registrado"} mono />
                    {datos.empresa.telefono && <Dato k="Teléfono" v={datos.empresa.telefono} mono />}
                    {datos.empresa.contacto_nombre && (
                      <Dato k="Contacto" v={`${datos.empresa.contacto_nombre}${datos.empresa.contacto_telefono ? ` · ${datos.empresa.contacto_telefono}` : ""}`} />
                    )}
                    {datos.empresa.estado && (
                      <Dato k="Estado del proveedor" v={
                        <span className={datos.empresa.estado === "activo" ? "text-green-700" : "text-red-600"}>
                          {datos.empresa.estado}
                        </span>
                      } />
                    )}
                  </>
                ) : fallos.includes("empresa") ? (
                  <DatosIlegibles titulo="No se pudieron leer los datos del operador tercerizado"
                    detalle={NOMBRE_FALLO.empresa} onReintentar={reintentar} />
                ) : (
                  <p className="text-[11.5px] text-amber-700">
                    Servicio tercerizado sin empresa vinculada.
                  </p>
                )}

                <div className="mt-2.5 pt-2.5 border-t border-gray-100">
                  <p className={`${ETIQUETA} mb-1`}>Conductor del tercero</p>
                  <Dato k="Nombre" v={datos.conductor?.nombre
                    || (fallos.includes("conductor") ? "no se pudo leer" : "sin asignar")} />
                  <Dato k="Licencia" v={datos.conductor?.licencia
                    || (fallos.includes("conductor") ? "no se pudo leer" : "no registrada")} mono />
                  <p className="text-[10px] text-gray-400 mt-1.5 leading-snug">
                    De un conductor tercerizado solo se puede verificar la licencia: <code className="font-mono">conductores_tercero</code> no
                    guarda SCTR ni exámenes médicos. Esas coberturas viajan por los documentos de la empresa.
                  </p>
                </div>

                {/* AQUÍ NO VA UN AVISO DE "el tercero no marca paraderos". Se puso una vez y era
                    falso: los conductores tercerizados usan la MISMA app AFA Conductor que los
                    propios — el login la busca en las dos tablas (app/conductor/page.tsx:155,
                    `for (const tabla of ["conductores", "conductores_tercero"])`) y toda la app
                    enruta por `_tabla`. Marcan paraderos igual, así que su línea de tiempo se
                    llena igual. El link con token (app/api/conductor-tercero/*) es una vía
                    ADICIONAL para quien no tenga la app instalada, no la única.
                    Y el Manifiesto MTC tampoco sale con "–": `datos.conductor` se llena desde
                    conductores_tercero (nombre + licencia) y se le pasa al documento.
                    Si un servicio concreto no tiene horas, la línea de tiempo lo dice parada por
                    parada ("sin marcar"), que es OBSERVACIÓN. Anticiparlo por ser tercerizado
                    era una suposición, y encima equivocada. */}
              </div>
            </Seccion>
          )}

          {/* ══ 5 · ECONOMÍA Y CIERRE ═══════════════════════════════════════════ */}
          <Seccion titulo="Economía y cierre" icono={<I.DollarSign size={12} color="#0b315f" />}>
            <div className={`${TARJETA} p-3`}>
              <Dato k="Gastos del servicio" v={soles(s?.gastos_total)} mono />

              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-[11px] text-gray-400 font-semibold">Viáticos al conductor</span>
                <button onClick={alternarViaticos}
                  title="Único flag manual que sobrevive: describe un hecho físico (efectivo entregado en mano) que el ERP no puede observar."
                  className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${FOCO} ${r.viaticos_entregados ? "bg-green-50 text-green-700 hover:bg-green-100" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>
                  {r.viaticos_entregados ? "✓ Entregados" : "○ Sin entregar"}
                </button>
              </div>

              {/* PRECIO / COSTO / MARGEN — solo admin. */}
              {verEconomia && (
                <div className="mt-2 pt-2 border-t border-gray-100">
                  <p className={`${ETIQUETA} mb-1`}>Solo administración</p>
                  <Dato k="Precio al cliente" v={soles(r.precio_cliente)} mono />
                  <Dato k="Costo del proveedor" v={soles(r.costo_proveedor)} mono />
                  <Dato k="Margen" v={
                    <span className={Number(r.margen) < 0 ? "text-red-600" : "text-green-700"}>{soles(r.margen)}</span>
                  } mono />
                </div>
              )}

              {/* CIERRE ADMINISTRATIVO (dimensión B). */}
              <div className="mt-2 pt-2 border-t border-gray-100">
                {cfgAdmin ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-gray-400 font-semibold">Cierre administrativo</span>
                    <span className="text-[11.5px] font-bold" style={{ color: cfgAdmin.color }}>
                      {cfgAdmin.label} <span className="font-normal text-gray-400">· {cfgAdmin.descripcion}</span>
                    </span>
                  </div>
                ) : finalizado ? (
                  <Hallazgo tono="ambar" icono={<I.DollarSign size={14} color="#b45309" />}
                    titulo="Pendiente de pasar a liquidación"
                    detalle={
                      <div>
                        <p>El servicio está finalizado pero nunca arrancó su cierre administrativo, así que no aparece en la cola de liquidación.</p>
                        <button onClick={pasarALiquidacion}
                          className={`mt-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors ${FOCO}`}>
                          Marcar “Por liquidar”
                        </button>
                      </div>
                    } />
                ) : (
                  <p className="text-[11px] text-gray-400">
                    El cierre administrativo arranca cuando el servicio pasa a <b>Finalizada</b>.
                  </p>
                )}
              </div>
            </div>
          </Seccion>

          {/* ══ 6 · DOCUMENTOS IMPRIMIBLES ══════════════════════════════════════
              Al final, que es donde se usan: primero se revisa el servicio, después se
              imprime. Cada botón deshabilitado dice POR QUÉ. */}
          <Seccion titulo="Documentos del servicio" icono={<I.FileText size={12} color="#0b315f" />}>
            <div className={`${TARJETA} p-3`}>
              <div className="flex gap-2 flex-wrap">
                <button onClick={imprimirManifiesto} disabled={!!motivoManifiesto} title={motivoManifiesto || "Manifiesto MTC (R.D. 1946-2009-MTC-15)"}
                  className={`${btn} bg-[#E3F1E6] hover:bg-[#cfe8d4] text-[#15803d]`}>
                  <I.FileText size={13} color="#15803d" /> Manifiesto MTC
                </button>
                <button onClick={imprimirReporte} disabled={!!motivoReporte} title={motivoReporte || "Reporte de Servicio"}
                  className={`${btn} bg-[#EAEFF6] hover:bg-[#dbe4f0] text-[#0b315f]`}>
                  <I.FileText size={13} color="#0b315f" /> Reporte de Servicio{enCurso ? " · preliminar" : ""}
                </button>
                <button onClick={() => onGps(s)} title="Ver el recorrido GPS del servicio"
                  className={`${btn} bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8]`}>
                  <I.Map size={13} color="#1d4ed8" /> Ver recorrido GPS
                </button>
              </div>

              {/* El motivo va ESCRITO, no solo en un `title` que hay que descubrir con el ratón. */}
              <div className="mt-2 space-y-0.5">
                {motivoManifiesto && <p className="text-[10.5px] text-gray-400">Manifiesto MTC: {motivoManifiesto}</p>}
                {motivoReporte && <p className="text-[10.5px] text-gray-400">Reporte de Servicio: {motivoReporte}</p>}
                {!cargando && (fallos.includes("gps") || (!!datos && datos.gpsTotal === null)) && (
                  <p className="text-[10.5px] text-gray-400">
                    Recorrido GPS: no se pudo leer el rastro. El mapa puede abrir vacío aunque sí haya puntos.
                  </p>
                )}
                {!cargando && datos && datos.gpsTotal === 0 && !fallos.includes("gps") && (
                  <p className="text-[10.5px] text-gray-400">
                    Recorrido GPS: no hay ningún punto en la ventana de este servicio. El mapa abrirá vacío.
                  </p>
                )}
                {!cargando && tiempos && (tiempos.inicio || tiempos.fin) && (
                  <p className="text-[10.5px] text-gray-400 leading-snug">
                    El Reporte imprime las horas derivadas <b>con su procedencia</b>
                    {tiempos.mostrarAmbosFines ? " y las dos horas de fin" : ""}, no el campo manual vacío.
                  </p>
                )}
              </div>
            </div>
          </Seccion>

          {/* ══ 8 · ACCIONES Y VISTA CLÁSICA ════════════════════════════════════
              DEUDA CONSCIENTE Y TEMPORAL. La tarjeta anterior (gastos, checklist de salida,
              reemplazo, teléfono) sigue viva aquí dentro, cerrada por defecto. Sus modales
              (ModalGastos, ModalChecklist, ModalReemplazo) viven en app/seguimiento/page.tsx
              y OTRA SESIÓN está editando ese archivo ahora mismo: moverlos hoy sería pelear
              por el mismo fichero y perder trabajo ajeno. Cuando el semáforo de puntualidad
              esté commiteado, esos modales deben salir a components/seguimiento/ y esta
              sección desaparecer. */}
          {children && (
            <Seccion titulo="Acciones y vista clásica">
              <div className={`${TARJETA} p-3`}>
                <Plegable abierto={false}
                  resumen={<span className="text-[12px] font-bold text-gray-600">Gastos, checklist de salida, reemplazo y contacto</span>}>
                  <div className="pt-1">{children}</div>
                </Plegable>
              </div>
            </Seccion>
          )}

          <p className="text-[10px] text-gray-400 text-center px-4 pb-2 leading-snug">
            Las horas de esta ficha se derivan de la evidencia que dejó el conductor (paradas marcadas,
            abordajes y GPS). Ninguna se guarda como dato oficial: lo que se teclea a mano queda marcado como tal.
          </p>
        </div>
      </div>
    </div>
  );
}
