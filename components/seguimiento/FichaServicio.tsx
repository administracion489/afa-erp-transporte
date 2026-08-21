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
//   · No duplica la lógica de los modales operativos (gastos, checklist de salida, reemplazo
//     de unidad): vive en components/seguimiento/ModalesServicio.tsx, se importa tal cual y
//     escribe en las mismas tablas de siempre. Aquí solo se decide CUÁNDO ofrecerlos.
//
// ══════════════════════════════════════════════════════════════════════════════
// ACCIONES CONDICIONADAS POR FASE — y la distinción que costó un defecto
//   El drawer anterior enseñaba los mismos botones a un servicio de mañana y a uno de hace
//   tres semanas. Pero "cuándo OCURRIÓ el hecho" y "cuándo se TECLEA" no son lo mismo, y
//   confundirlos apaga botones que sí hacen falta:
//     · CHECKLIST DE SALIDA — es una COMPROBACIÓN previa al despacho. Firmarlo sobre un
//       servicio ya terminado no verifica nada: no queda nada que impedir. Se deshabilita
//       en estado terminal (`esEstadoTerminal`).
//     · REEMPLAZO DE UNIDAD — es un REGISTRO de lo que de verdad salió a la calle. Casi
//       siempre se entera operación tarde ("salió la B-2, no la CNQ396"), y documentarlo a
//       posteriori es justo lo que este rediseño persigue: sin él, `unidad_reemplazo_placa`
//       queda vacío y se factura la unidad equivocada. Solo se cierra en CANCELADA, donde no
//       hubo unidad que reemplazar.
//   El que no aplica se pinta DESHABILITADO con el motivo escrito — no oculto —, mismo
//   criterio que la sección 6: un botón que desaparece se lee como un bug; uno apagado que
//   dice por qué, se entiende.
//   Los gastos NO se condicionan: un peaje o un viático se registran cuando aparece la
//   boleta, y eso pasa casi siempre DESPUÉS del servicio.
//
// ══════════════════════════════════════════════════════════════════════════════
// LO QUE ESTA FICHA HEREDA DE LA TARJETA CLÁSICA (y por qué NO se perdió)
//   · EVIDENCIA DE PUNTUALIDAD (sección 2): el veredicto del semáforo del servidor con su
//     causa y su evidencia. El chip de la lista dice QUÉ pasa; aquí se dice POR QUÉ lo
//     sabemos. Un aviso que no se puede verificar se ignora en una semana — y el chip de la
//     fila encima vive en un contenedor `hidden md:flex`, o sea que en tablet no existe.
//   · REGISTRO MANUAL DEL FIN (sección 2): `reservas.hora_real_fin` se quedó sin ningún
//     escritor humano en todo el ERP cuando desapareció la tarjeta, y lib/liquidacion-datos.ts
//     lo imprime como "llegada". Se pide igual que el inicio: en un campo, nunca `now()`.
//   · CONFORMIDAD FIRMADA (sección 5): el toggle de la tarjeta eventual era el único
//     escritor Y lector de `conformidad_firmada` en el repo. Vive ahora donde le toca, con
//     el resto del cierre administrativo.
//   · RESPALDO DOCUMENTAL (arriba del todo): `s.docs_vencidos` / `s.seguro_vence_hoy` los
//     tiene la PÁGINA sin depender de la carga perezosa de esta ficha. No se duplican en el
//     camino feliz; solo se usan cuando `evaluarAptitud` no ha podido pronunciarse.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  ESTADOS_RESERVA, ESTADOS_ADMIN, ESTADO_ADMIN_INICIAL, normalizaEstado, esEstadoTerminal,
} from "@/lib/estados";
import { ModalGastos, ModalChecklist, ModalReemplazo } from "./ModalesServicio";
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
// El semáforo de puntualidad NO se calcula aquí: llega ya dictaminado en `s.puntualidad`
// (lo produce /api/seguimiento/retrasos con lib/retrasos.ts). De ese módulo solo se importa
// la PALETA, para que el mismo nivel no tenga un color en la lista y otro en la ficha.
import { NIVEL_RETRASO, type NivelRetraso } from "@/lib/retrasos";

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

/**
 * VEREDICTO DE PUNTUALIDAD tal como llega del endpoint (espejo aplanado de `Veredicto` de
 * lib/retrasos.ts). El tipo vive en app/seguimiento/page.tsx y NO está exportado — se
 * redeclara aquí en vez de acoplar este componente a un archivo que otra sesión edita.
 */
type Puntualidad = {
  nivel: NivelRetraso;
  minutos: number | null;
  causa: string;
  evidencia: string;
};

/**
 * ── EVIDENCIA DE PUNTUALIDAD ──
 * El chip de la lista dice QUÉ pasa; aquí se dice POR QUÉ lo sabemos. Sin la evidencia
 * (distancia al punto, antigüedad del último fix, ETA contra la hora objetivo) el operador no
 * puede verificar el veredicto, y un aviso que no se puede verificar se ignora en una semana.
 *
 * ESTE COMPONENTE NO OPINA: el nivel, los minutos, la causa y la evidencia los dictamina el
 * servidor (lib/retrasos.ts vía /api/seguimiento/retrasos) y aquí solo se pintan, con SU
 * paleta (`NIVEL_RETRASO`). Si el veredicto está mal, se corrige en el motor.
 *
 * No se pinta para "en_hora" ni "na": una ficha que también grita cuando todo va bien enseña
 * al operador a no mirarla. Y no depende de `cargarFichaDatos`: este dato lo trae la página,
 * así que sigue en pie aunque la carga perezosa de la ficha se caiga.
 */
function EvidenciaPuntualidad({ p }: { p: Puntualidad }) {
  // Un nivel desconocido (endpoint más nuevo que este bundle) caería a `undefined` y
  // reventaría al leer `.label`. Se degrada a "na", que es gris y no afirma nada.
  const meta = NIVEL_RETRASO[p.nivel] ?? NIVEL_RETRASO.na;
  return (
    <div className="mb-2.5 rounded-xl px-3 py-2.5 border" style={{ background: meta.bg, borderColor: `${meta.color}33` }}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-black text-xs" style={{ color: meta.color }}>
          {meta.label}{p.minutos !== null && p.minutos !== 0 ? ` · ${p.minutos > 0 ? "+" : ""}${p.minutos} min` : ""}
        </span>
        {p.causa && <span className="text-[11px] text-gray-600 font-semibold">{p.causa}</span>}
      </div>
      {p.evidencia && <p className="text-[11px] text-gray-500 mt-1 leading-snug">{p.evidencia}</p>}
      {p.nivel === "en_punto_sin_iniciar" && (
        <p className="text-[11px] mt-1.5 font-semibold" style={{ color: meta.color }}>
          {/* NO invita a "hacerlo tú con Check-in": ese botón escribía la hora del CLIC, y
              justo en este nivel el servidor YA sabe por GPS desde cuándo el bus está en el
              paradero. Registrarlo a mano ahora sería empeorar el dato. */}
          No hace falta despachar nada: el bus ya está en el paradero. Falta que el conductor pulse Iniciar en su app.
        </p>
      )}
      {p.nivel === "sin_rastreo" && (
        <p className="text-[11px] mt-1.5 text-gray-500">
          Esto NO afirma que el bus no esté: afirma que no hay señal para saberlo. Confírmalo por teléfono.
        </p>
      )}
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
  s, onClose, onRefresh, onGps, empresaPerfil, esAdmin,
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
  /** Gemelo del anterior para la LLEGADA. Dos campos separados y no uno reutilizado: son dos
   *  hechos distintos y pueden pedirse a la vez (servicio sin ninguna hora registrada). */
  const [horaFinManual, setHoraFinManual] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [guardandoFin, setGuardandoFin] = useState(false);
  /** Contador de reintentos: cambiarlo relanza la carga. Es la acción que acompaña al estado
   *  neutro — si la ficha no puede afirmar nada porque una lectura falló, lo mínimo es dejar
   *  volver a pedirla sin cerrar y reabrir el drawer. */
  const [intento, setIntento] = useState(0);
  const reintentar = useCallback(() => setIntento(n => n + 1), []);

  /** Modal operativo abierto, si hay alguno. UN solo estado y no tres booleanos: los tres son
   *  mutuamente excluyentes y con booleanos sueltos se pueden abrir dos a la vez. */
  const [modal, setModal] = useState<"gastos" | "checklist" | "reemplazo" | null>(null);
  /** Cerrar cualquier modal refresca. ModalGastos escribe en `gastos` en cuanto se pulsa
   *  Agregar/eliminar (no al salir), así que sin este refresco el total de la sección 5 se
   *  quedaría con la cifra vieja hasta la siguiente recarga. */
  const cerrarModal = useCallback(() => { setModal(null); onRefresh(); }, [onRefresh]);

  // ── ESC cierra (réplica del useEffect del drawer anterior) ───────────────────
  // Con un modal encima, ESC cierra PRIMERO el modal: cerrar el drawer entero por debajo
  // dejaría el modal flotando sobre la lista, sin nada detrás que lo explique.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modal) { cerrarModal(); return; }
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, modal, cerrarModal]);

  // ── Carga LAZY, con cancelación ──────────────────────────────────────────────
  // Nada de cargar en el render: al cambiar de servicio (o al remontar) la respuesta vieja
  // podría llegar después de la nueva y pintar el servicio equivocado. El flag `vivo` corta.
  useEffect(() => {
    if (!r) return;
    let vivo = true;
    setFase("cargando"); setDatos(null); setHoraManual(""); setHoraFinManual(""); setAhoraMs(Date.now());
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
    // Registrar la salida también pone el servicio EN RUTA. Antes esa transición la hacía el
    // botón "Hacer Check-in" del tablero, que se eliminó por escribir la hora del clic en vez
    // de la de salida; si nadie la heredaba, un servicio registrado a mano se quedaba clavado
    // en "programada" para siempre y el Reporte de Servicio (que exige en_curso o finalizada)
    // no se habilitaba nunca. Solo aplica a un servicio que aún no arrancó: jamás retrocede uno
    // finalizado ni resucita uno cancelado.
    const estadoAhora = normalizaEstado(r?.estado);
    const arrancar = estadoAhora === "pendiente" || estadoAhora === "programada" || estadoAhora === "confirmada";
    const { error } = await supabase.from("reservas")
      .update({ hora_real_inicio: `${horaManual}:00`, ...(arrancar ? { estado: "en_curso" } : {}) })
      .eq("id", rid);
    setGuardando(false);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, horaManual, onRefresh, r?.estado]);

  /**
   * Registro MANUAL de la hora de LLEGADA (`reservas.hora_real_fin`).
   *
   * POR QUÉ EXISTE: al podar la tarjeta clásica se fue con ella `guardarHoras`, que escribía
   * inicio Y FIN. Los únicos escritores que quedaron son los endpoints del conductor y el
   * Radar; ninguno lo escribe si el conductor no cerró el servicio desde su app. Mientras
   * tanto lib/liquidacion-datos.ts imprime `hora_real_fin` como la LLEGADA del servicio: el
   * operador veía la hora correcta en pantalla (derivada del último paradero) y no tenía
   * dónde escribirla, así que la liquidación salía con la llegada en blanco para siempre.
   *
   * MISMO CRITERIO QUE EL INICIO, sin excepciones:
   *   · se PIDE en un campo — jamás `now()`. Persistir la hora del clic ya costó un bug real:
   *     sobre un servicio de las 05:00 revisado a las 11:00 se guardaba "salió 11:00" con
   *     etiqueta de dato humano fiable.
   *   · solo se ofrece cuando NO hay ninguna evidencia de la que derivar el fin
   *     (`puedeRegistrarFinManual`), y nunca con la evidencia a medio leer.
   *   · queda con fuente "operador" (lib/servicio-tiempos.ts:757 lo lee así), no como
   *     evidencia del viaje.
   *
   * Y arrastra el CIERRE, igual que hacía la tarjeta clásica (HEAD:page.tsx:538-547): una
   * llegada registrada es un servicio terminado, así que pasa a `finalizada` y, si nunca
   * arrancó su dimensión B, siembra `estado_admin` para que entre en la cola de liquidación.
   * `estado_admin` solo se siembra si está VACÍO: aquí no se pisa ningún valor existente.
   */
  const guardarFinManual = useCallback(async () => {
    if (!rid || !/^\d{2}:\d{2}$/.test(horaFinManual)) return;
    setGuardandoFin(true);
    const estadoAhora = normalizaEstado(r?.estado);
    // Un cancelado no llega a ningún sitio y este campo ni se le ofrece; la comprobación se
    // repite aquí porque es la que protege la ESCRITURA, no la que decide qué se pinta.
    const cerrar = estadoAhora !== "cancelada" && estadoAhora !== "finalizada";
    const yaTieneAdmin = !!r?.estado_admin;
    const { error } = await supabase.from("reservas")
      .update({
        hora_real_fin: `${horaFinManual}:00`,
        ...(cerrar ? { estado: "finalizada" } : {}),
        ...(cerrar && !yaTieneAdmin ? { estado_admin: ESTADO_ADMIN_INICIAL } : {}),
      })
      .eq("id", rid);
    setGuardandoFin(false);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, horaFinManual, onRefresh, r]);

  /** Viáticos: flag manual que describe un hecho físico (se entregó efectivo en mano) que el
   *  ERP no puede observar por ningún otro medio. */
  const alternarViaticos = useCallback(async () => {
    if (!rid) return;
    const { error } = await supabase.from("reservas")
      .update({ viaticos_entregados: !r?.viaticos_entregados }).eq("id", rid);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, r?.viaticos_entregados, onRefresh]);

  /**
   * Conformidad del cliente (`reservas.conformidad_firmada`).
   *
   * La columna se quedó HUÉRFANA con la poda: el toggle de la tarjeta eventual era su único
   * escritor y su único lector en todo el repo. Se le da sitio aquí, en el cierre
   * administrativo, en vez de dejar una columna muerta — porque el dato es exactamente el
   * mismo tipo de cosa que los viáticos: un hecho FÍSICO (el cliente firmó el acta al bajar)
   * que el ERP no puede observar por ningún otro medio y que se necesita para facturar.
   *
   * Se ofrece en TODO servicio, no solo en los eventuales: la firma de conformidad se pide
   * igual en un servicio recurrente, y la tarjeta que lo limitaba a los eventuales ya no
   * existe. En un servicio CANCELADO se apaga: no hubo viaje del que dar conformidad.
   */
  const alternarConformidad = useCallback(async () => {
    if (!rid) return;
    const { error } = await supabase.from("reservas")
      .update({ conformidad_firmada: !r?.conformidad_firmada }).eq("id", rid);
    if (error) { alert("No se pudo guardar: " + error.message); return; }
    onRefresh();
  }, [rid, r, onRefresh]);

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

  /**
   * RESPALDO DOCUMENTAL DE LA PÁGINA. `s.docs_vencidos` y `s.seguro_vence_hoy` los calcula el
   * lote diario de /seguimiento y ya están en memoria: NO dependen de `cargarFichaDatos`.
   *
   * En el camino feliz no se pintan — `evaluarAptitud` responde la misma pregunta mejor
   * (contra la FECHA DEL SERVICIO, con la lista de obligatorios y con el filtro por placa de
   * los terceros) y duplicarlas daría dos avisos del mismo documento, a veces contradictorios.
   * Pero cuando la ficha NO ha podido pronunciarse, callar es peor: el aviso duro se perdería
   * entero, y el chip rojo "DOC" de la fila vive en un contenedor `hidden md:flex`, o sea que
   * en una tablet no existe. Entonces sí se usa el dato viejo, diciendo de dónde sale y contra
   * qué está medido.
   */
  const sinVeredictoDoc = !cargando && (fase === "error" || fallosDoc.length > 0 || !aptitud);
  const docsVencidosPagina: string[] = sinVeredictoDoc ? (s?.docs_vencidos ?? []) : [];
  const seguroHoyPagina = sinVeredictoDoc && !!s?.seguro_vence_hoy;

  /** Veredicto de puntualidad que llega YA CALCULADO del servidor (solo existe para HOY:
   *  /seguimiento no lo pide para otros días, y la puntualidad es una pregunta del presente).
   *  "en_hora" y "na" no se pintan: una ficha que también grita cuando todo va bien enseña a
   *  no mirarla. */
  const punt: Puntualidad | null = (() => {
    const p = s?.puntualidad as Puntualidad | undefined;
    if (!p || !p.nivel || p.nivel === "na" || p.nivel === "en_hora") return null;
    return p;
  })();

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

  /**
   * POR QUÉ NO SE PUEDE HACER CADA ACCIÓN (null = sí se puede). Son DOS motivos y no uno,
   * porque las dos acciones no son la misma cosa (ver la cabecera del archivo):
   *
   *   · CHECKLIST DE SALIDA = comprobación PREVIA al despacho. Sobre un servicio terminal ya
   *     no queda nada que impedir, así que se apaga. `esEstadoTerminal` en vez de
   *     `finalizado || cancelado` a mano: la lista la define lib/estados.ts y si mañana entra
   *     otra terminal (p. ej. "anulada") esta ficha se entera sola.
   *   · REEMPLAZO DE UNIDAD = REGISTRO de lo que de verdad salió. Se puede teclear después:
   *     operación se entera tarde casi siempre, y si no se deja registrar, se factura la
   *     unidad programada en vez de la real. Solo se apaga en CANCELADA — ahí no salió nada.
   */
  // Solo se apaga del todo en CANCELADA: ahí no hubo salida que verificar. En un servicio
  // TERMINADO el botón sigue abriendo el checklist, pero en modo CONSULTA — firmarlo después de
  // la salida sería fabricar evidencia; no poder leerlo sería perder la que ya existe, que es
  // justo lo que hace falta cuando algo salió mal.
  const checklistSoloLectura = esEstadoTerminal(estado) && !cancelado;
  const motivoChecklist = cancelado ? "el servicio está anulado, no hay salida que verificar" : null;
  const motivoReemplazo = cancelado
    ? "el servicio está anulado: no salió ninguna unidad a la que reemplazar"
    : null;

  /**
   * ¿PUEDE EL OPERADOR TECLEAR LA HORA DE LLEGADA?
   *
   * lib/servicio-tiempos.ts expone `puedeRegistrarInicioManual` pero NO un equivalente para el
   * fin, y ese módulo es de otra sesión: la regla se replica aquí con el MISMO razonamiento,
   * no se inventa uno nuevo. Las cuatro condiciones, en el mismo orden que el motor:
   *   1. `t.fin === null` — si el sistema ya sabe la hora (paradero, cierre del conductor, GPS
   *      o un valor tecleado antes), un campo editable al lado solo sirve para contradecirla.
   *      `fin` es el MÁS TARDÍO de todas las fuentes, así que null aquí es "no hay ninguna".
   *   2. línea de tiempo no vacía — el único caso vacío es CANCELADA, que no admite registro.
   *   3. el servicio tiene que haber empezado: a un "por salir" no se le pide la llegada.
   *   4. y la evidencia tiene que haberse podido LEER. Con una pieza caída, `fin === null`
   *      puede significar "no lo pude leer", y ofrecer el campo ahí es invitar a teclear a
   *      mano encima de un dato que sí existe.
   */
  const puedeRegistrarFinManual = !!tiempos
    && tiempos.fin === null
    && tiempos.linea.length > 0
    && nivel !== "por_salir"
    && !evidenciaIlegible;

  const btn =`flex items-center gap-1.5 text-[11.5px] font-bold px-3 py-2 rounded-xl transition-colors ${FOCO} disabled:opacity-40 disabled:cursor-not-allowed`;

  // ══════════════════════════════════════════════════════════════════════════════
  return (
    <>
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

          {/* ══ RESPALDO DOCUMENTAL DE LA PÁGINA ═══════════════════════════════
              Solo cuando esta ficha NO ha podido dar su propio veredicto documental (carga
              caída o pieza documental ilegible). Es el aviso duro que pintaba la tarjeta
              clásica, con datos que la PÁGINA ya tiene en memoria y que no dependen de
              `cargarFichaDatos`. Va lo primero y en rojo: "no despachar" es de las pocas
              cosas que no admiten esperar a un reintento. Se dice de dónde sale y contra qué
              está medido, porque el criterio NO es el mismo que el de `evaluarAptitud`. */}
          {docsVencidosPagina.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-2xl px-3 py-2.5 mb-3 flex items-start gap-2.5">
              <span className="mt-0.5 flex-shrink-0"><I.Shield size={14} color="#b91c1c" /></span>
              <div className="min-w-0">
                <p className="text-[12px] font-black text-red-700 leading-snug">
                  ⛔ DOCUMENTOS VENCIDOS: {docsVencidosPagina.join(", ")} — No despachar la unidad
                </p>
                <p className="text-[10.5px] text-red-600 leading-snug mt-1">
                  Dato del tablero, medido contra HOY. Se muestra porque la verificación documental de
                  esta ficha (que mide contra la fecha del servicio) no se pudo completar.
                </p>
              </div>
            </div>
          )}
          {seguroHoyPagina && (
            <div className="bg-red-50 border border-red-100 rounded-2xl px-3 py-2.5 mb-3 flex items-start gap-2.5">
              <span className="mt-0.5 flex-shrink-0"><I.Shield size={14} color="#dc2626" /></span>
              <div className="min-w-0">
                <p className="text-[12px] font-bold text-red-600 leading-snug">
                  SEGURO DE LA UNIDAD VENCE HOY — Verificar antes de salir
                </p>
                <p className="text-[10.5px] text-red-600 leading-snug mt-1">
                  Dato del tablero: la verificación documental de esta ficha no se pudo completar.
                </p>
              </div>
            </div>
          )}

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
               documento, a veces contradictorios. La ÚNICA excepción es el respaldo de arriba
               del todo, que solo entra cuando evaluarAptitud no ha podido pronunciarse: ahí no
               hay duplicado posible, o sale ese aviso o no sale ninguno. */
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
              {/* EVIDENCIA DE PUNTUALIDAD — lo primero de la sección, porque es lo único de
                  aquí que puede exigir una llamada AHORA. Va en esta sección y no en
                  "Requiere atención" porque habla de HORAS, que es de lo que trata esta.
                  Se pinta al margen de `fase`: el veredicto lo trae la página ya calculado
                  (s.puntualidad ← /api/seguimiento/retrasos), así que sigue en pie aunque la
                  carga perezosa de la ficha se haya caído. */}
              {punt && <EvidenciaPuntualidad p={punt} />}

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

              {/* ── REGISTRO MANUAL DE LA LLEGADA ────────────────────────────────
                  Bloque PROPIO y no una segunda casilla del de arriba: la salida y la llegada
                  son dos hechos distintos y casi nunca faltan los dos a la vez. Aquí se cierra
                  el agujero que dejó la poda: `reservas.hora_real_fin` se quedó sin ningún
                  escritor humano, y es la columna que lib/liquidacion-datos.ts imprime como
                  "llegada" en la liquidación del cliente. */}
              {puedeRegistrarFinManual && (
                <div className="mt-3 pt-2.5 border-t border-gray-100">
                  <p className="text-[12px] font-bold text-gray-500">Sin hora de llegada</p>
                  <p className="text-[11px] text-gray-400 leading-snug mt-0.5">
                    El conductor no cerró el servicio y no hay ninguna llegada al último paradero de la que
                    derivarla. La liquidación imprime esta hora: sin ella sale en blanco.
                  </p>
                  <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                    <input type="time" value={horaFinManual} onChange={e => setHoraFinManual(e.target.value)}
                      aria-label="Hora real de llegada"
                      className={`border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] font-bold font-mono text-[#0b315f] ${FOCO} focus:border-[#0b315f]`} />
                    <button onClick={guardarFinManual} disabled={guardandoFin || !/^\d{2}:\d{2}$/.test(horaFinManual)}
                      className={`${btn} bg-[#0b315f] hover:bg-[#1262bd] text-white`}>
                      {guardandoFin ? "Guardando…" : "Registrar llegada"}
                    </button>
                    <p className="text-[10px] text-gray-400 basis-full leading-snug">
                      {/* Se dice lo que va a pasar ANTES de que pase: el botón no solo escribe una
                          hora, cierra el servicio. Un efecto lateral que sorprende es un efecto
                          lateral que alguien deshace a mano en la base de datos. */}
                      Escribe la hora que indiques — <b>nunca la hora del clic</b> — y quedará marcada como
                      <b> registrada por operación</b>{!finalizado ? ", además de dar el servicio por finalizado y ponerlo en la cola de liquidación" : ""}.
                      Regístrala solo cuando el servicio haya terminado de verdad.
                    </p>
                  </div>
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

              {/* ── ACCIONES SOBRE LA UNIDAD ─────────────────────────────────────
                  Viven aquí y no en un cajón aparte porque son lo que se hace con lo que
                  se acaba de leer arriba: si un documento avisa, se reemplaza la unidad; si
                  todo está conforme, se firma el checklist. Cada una con SU condición: el
                  checklist es una comprobación previa (muere al terminar el servicio), el
                  reemplazo es un registro de lo que pasó (se puede teclear después). Ver la
                  cabecera del archivo. */}
              <div className="mt-2.5 pt-2.5 border-t border-gray-100">
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => setModal("checklist")} disabled={!!motivoChecklist}
                    title={motivoChecklist
                      || (checklistSoloLectura
                        ? "Consultar lo que se verificó antes de despachar (solo lectura: el servicio ya terminó)"
                        : "Checklist de salida: las 8 verificaciones antes de despachar")}
                    className={`${btn} bg-[#E3F1E6] hover:bg-[#cfe8d4] text-[#15803d]`}>
                    <I.Check size={13} color="#15803d" /> {checklistSoloLectura ? "Ver checklist de salida" : "Checklist de salida"}
                  </button>
                  <button onClick={() => setModal("reemplazo")} disabled={!!motivoReemplazo}
                    title={motivoReemplazo
                      || (finalizado
                        ? "Registrar a posteriori la unidad que de verdad salió, en lugar de la programada"
                        : "Registrar la unidad que sale en lugar de la programada")}
                    className={`${btn} bg-[#FDF3E3] hover:bg-[#fbe9cd] text-[#b45309]`}>
                    <I.Swap size={13} color="#b45309" /> Reemplazo de unidad
                  </button>
                </div>
                {/* El motivo va ESCRITO, no solo en un `title` que hay que descubrir con el
                    ratón: mismo criterio que la sección 6. Uno por acción: decir "las dos
                    están apagadas" cuando solo lo está una es exactamente igual de inútil. */}
                <div className="mt-2 space-y-0.5">
                  {motivoChecklist && (
                    <p className="text-[10.5px] text-gray-400 leading-snug">
                      Checklist de salida: {motivoChecklist}.
                    </p>
                  )}
                  {motivoReemplazo && (
                    <p className="text-[10.5px] text-gray-400 leading-snug">
                      Reemplazo de unidad: {motivoReemplazo}. Si hubo uno registrado, sale arriba en “Reemplazada por”.
                    </p>
                  )}
                  {!motivoReemplazo && finalizado && (
                    // Un botón habilitado sobre un servicio terminado necesita decir para qué:
                    // sin esta línea parece un descuido, y con ella es una invitación a corregir
                    // el dato que factura.
                    <p className="text-[10.5px] text-gray-400 leading-snug">
                      El servicio ya terminó, pero el reemplazo sigue disponible: documenta qué unidad
                      salió de verdad. Sin ese registro se factura la programada.
                    </p>
                  )}
                </div>
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
              {/* GASTOS: la cifra ES el botón. No se condiciona por fase — la boleta del peaje
                  aparece casi siempre DESPUÉS del servicio, y un gasto que no se puede
                  registrar es un gasto que se pierde. */}
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="text-[11px] text-gray-400 font-semibold">Gastos del servicio</span>
                <button onClick={() => setModal("gastos")}
                  title="Abrir el control de gastos: ver, agregar o quitar gastos operativos de este servicio"
                  className={`text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors flex items-center gap-1.5 ${FOCO}`}>
                  <I.DollarSign size={11} />
                  <span className="font-mono text-[11px]">{soles(s?.gastos_total)}</span>
                  <span className="text-gray-400">· gestionar</span>
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-[11px] text-gray-400 font-semibold">Viáticos al conductor</span>
                <button onClick={alternarViaticos}
                  title="Flag manual: describe un hecho físico (efectivo entregado en mano) que el ERP no puede observar."
                  className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${FOCO} ${r.viaticos_entregados ? "bg-green-50 text-green-700 hover:bg-green-100" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>
                  {r.viaticos_entregados ? "✓ Entregados" : "○ Sin entregar"}
                </button>
              </div>

              {/* CONFORMIDAD DEL CLIENTE. Estaba solo en la tarjeta eventual y se quedó sin
                  sitio con la poda: `conformidad_firmada` no tenía ya ni un escritor ni un
                  lector en todo el repo. Vive aquí porque es cierre administrativo — es lo que
                  respalda la factura cuando el cliente reclama — y es el mismo tipo de dato que
                  los viáticos: un hecho físico (firmó el acta al bajar) que el ERP no observa. */}
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-[11px] text-gray-400 font-semibold">Conformidad del cliente</span>
                <button onClick={alternarConformidad} disabled={cancelado}
                  title={cancelado
                    ? "Servicio anulado: no hubo viaje del que firmar conformidad"
                    : "El cliente firmó la conformidad del servicio (acta en papel o correo de aceptación). Respalda la facturación."}
                  className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${FOCO} disabled:opacity-40 disabled:cursor-not-allowed ${r.conformidad_firmada ? "bg-green-50 text-green-700 hover:bg-green-100" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>
                  {r.conformidad_firmada ? "✓ Firmada" : "○ Sin firmar"}
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

          {/* La sección 8 ("Acciones y vista clásica") se ELIMINÓ. Era un acordeón cerrado con la
              tarjeta antigua entera dentro, y existía solo porque sus modales vivían en
              app/seguimiento/page.tsx. Ahora viven en ./ModalesServicio y se disparan desde la
              sección a la que pertenecen: gastos y viáticos en "Economía y cierre", checklist y
              reemplazo en "Unidad, conductor y cumplimiento", teléfono junto al conductor. Un
              cajón llamado "vista clásica" es donde va a morir lo que nadie quiso ordenar. */}

          <p className="text-[10px] text-gray-400 text-center px-4 pb-2 leading-snug">
            Las horas de esta ficha se derivan de la evidencia que dejó el conductor (paradas marcadas,
            abordajes y GPS). Ninguna se guarda como dato oficial: lo que se teclea a mano queda marcado como tal.
          </p>
        </div>
      </div>
    </div>

    {/* ══ MODALES OPERATIVOS ═══════════════════════════════════════════════════
        HERMANOS del drawer, no hijos: el contenedor de arriba es `fixed z-40` y eso abre un
        contexto de apilamiento propio: un modal `z-50` metido dentro solo sería z-50 RESPECTO
        A SUS HERMANOS, y seguiría por debajo de cualquier cosa de la página con z-45. Aquí
        fuera, el 50 gana al 40 de verdad.
        `rid != null` porque los tres escriben con `.eq("id", reservaId)`: sin id, esa consulta
        no apunta a ninguna fila concreta y no se lanza siquiera. */}
    {rid != null && modal === "gastos" && (
      <ModalGastos reservaId={rid} vehiculoId={(r as any).vehiculo_id ?? null}
        cliente={s?.cliente_nombre || "—"}
        onClose={() => setModal(null)} onSaved={onRefresh} />
    )}
    {rid != null && modal === "checklist" && (
      <ModalChecklist reservaId={rid} cliente={s?.cliente_nombre || "—"} soloLectura={checklistSoloLectura}
        onClose={() => setModal(null)} onSaved={onRefresh} />
    )}
    {rid != null && modal === "reemplazo" && (
      <ModalReemplazo reservaId={rid} placaOriginal={placa || "sin unidad"}
        onClose={() => setModal(null)} onSaved={onRefresh} />
    )}
    </>
  );
}
