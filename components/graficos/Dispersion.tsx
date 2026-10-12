"use client";

// components/graficos/Dispersion.tsx — Galones (o m³) contra km, un punto por tramo.
//
// Los puntos y su CLASE los decide lib/combustible/dispersion.ts con el veredicto del motor de
// rendimiento (`juzgarTramo`); este archivo no juzga nada, solo pinta. Una pantalla que
// decidiera aquí qué punto es "bajo" sería un segundo motor contestando la misma pregunta, y
// terminaría contestando distinto que la tabla de al lado.
//
// CÓMO SE LEE: con el tanque lleno a tanque lleno, un tramo normal cae cerca de la recta
// `cantidad = km ÷ rendimiento`. Por encima, la unidad gastó más de lo que suele (consumió de
// más); por debajo, rindió más de lo posible, que casi siempre es una carga sin registrar.
//
// REGLAS DEL DIBUJO, y cada una tiene su porqué:
//
//   · UN COLOR POR CLASE, Y NUNCA SOLO EL COLOR. El implausible lleva una ×, el tramo
//     incompleto va hueco, y la leyenda nombra cada clase con su conteo. Paleta validada para
//     daltonismo (todos los pares ΔE ≥ 13): azul, rojo, ámbar, pizarra y gris.
//   · NINGÚN TRAMO DESAPARECE. Lo que no tiene punto (primera carga, sin km, tanque parcial, el
//     implausible con un km imposible…) se cuenta debajo con la etiqueta de su motivo, y su
//     frase (`textoSinPunto`, del motor) va en el tooltip. Todo punto que llega tiene un km de
//     fiar (`Tramo.kmConfiable`), así que la escala la ponen TODOS: ninguno se recorta.
//   · LAS LÍNEAS DE REFERENCIA SOLO SI EL MOTOR LAS DA (`datos.referencia`, una sola unidad
//     filtrada). Sin filtro, una "mediana de la flota" sería un número que no existe en ningún
//     sitio del ERP.
//   · EL ANCHO SE MIDE, NO SE ESCALA (`useAnchoMedido`): en un teléfono los rótulos de los
//     ejes conservan su tamaño y no hay scroll horizontal.

import React from "react";
import { etiquetaMotivo } from "@/lib/rendimiento";
import type { MotivoSinRendimiento } from "@/lib/rendimiento";
import { textoSinPunto } from "@/lib/combustible/dispersion";
import type { Dispersion as DatosDispersion, PuntoDispersion, ClasePunto } from "@/lib/combustible/dispersion";
import { useAnchoMedido, pasoLimpio } from "@/components/graficos/SerieComparada";

const SUPERFICIE = "#ffffff";
const REJILLA = "#eef2f7";
const EJE = "#cbd5e1";
const TINTA_SUAVE = "#64748b";
const TINTA = "#334155";

/**
 * Cada clase: su color, su forma y cómo se llama. `orden` es el orden de dibujo (lo raro va
 * encima, para que se vea y se pueda tocar) y también el de la leyenda.
 */
const CLASES: Record<ClasePunto, { color: string; forma: "lleno" | "x" | "hueco"; etiqueta: string; ayuda: string; orden: number }> = {
  denominador_incompleto: {
    color: "#94a3b8", forma: "hueco", orden: 0,
    etiqueta: "Tramo incompleto (no se mide)",
    ayuda: "Sus km son de fiar pero el combustible de la cuenta no está completo (bicombustible o una carga sin km dentro).",
  },
  normal: {
    color: "#2563eb", forma: "lleno", orden: 1,
    etiqueta: "Normal",
    ayuda: "Rinde dentro de lo habitual de su unidad.",
  },
  implausible: {
    color: "#334155", forma: "x", orden: 2,
    etiqueta: "Implausible (descartado)",
    ayuda: "Supera el techo físico de su combustible: no es una medición, es un hueco de registro o un km mal tecleado.",
  },
  alto: {
    color: "#f59e0b", forma: "lleno", orden: 3,
    etiqueta: "Falta registrar una carga",
    ayuda: "Rindió más de lo posible para su unidad: casi siempre es combustible comprado que no está en el libro.",
  },
  bajo: {
    color: "#dc2626", forma: "lleno", orden: 4,
    etiqueta: "Consumió de más",
    ayuda: "Rindió muy por debajo de lo habitual de su unidad: plata que se fue.",
  },
};

/** La leyenda va en el orden en que se lee el gráfico: lo normal, lo que hay que mirar, lo que no se mide. */
const ORDEN_LEYENDA: ClasePunto[] = ["normal", "bajo", "alto", "implausible", "denominador_incompleto"];

const R_MARCA = 4.5;   // 9 px de diámetro (≥ 8 px)
const R_ANILLO = 6.5;  // + 2 px de anillo del color del fondo
const R_TOQUE = 12;    // 24 px: el objetivo de clic es mayor que la marca

const fmt0 = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 0 });
const fmt1 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = (n: number) => n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtFecha = (f: string) => {
  const d = new Date(String(f).slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? String(f) : d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
};
function fmtEje(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toLocaleString("es-PE", { maximumFractionDigits: 1 })} M`;
  if (a >= 1e4) return `${(n / 1e3).toLocaleString("es-PE", { maximumFractionDigits: 0 })} K`;
  return n.toLocaleString("es-PE", { maximumFractionDigits: a >= 10 ? 0 : 1 });
}

const esNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Un punto con sus dos coordenadas comprobadas. */
type Ubicable = PuntoDispersion & { km: number; cantidad: number };
const esUbicable = (p: PuntoDispersion): p is Ubicable => esNum(p.km) && esNum(p.cantidad);

function marcasDe(max: number): number[] {
  const paso = pasoLimpio(max > 0 ? max : 1, 5);
  const techo = Math.max(paso, Math.ceil((max > 0 ? max : 1) / paso) * paso);
  const out: number[] = [];
  for (let m = 0; m <= techo + paso / 2; m += paso) out.push(Math.round(m / paso) * paso);
  return out;
}

/** La marca de una clase centrada en (0, 0), con su anillo del color del fondo. */
function Marca({ clase }: { clase: ClasePunto }) {
  const c = CLASES[clase];
  return (
    <>
      <circle className="afa-disp-anillo" r={R_ANILLO} fill={SUPERFICIE} />
      {c.forma === "lleno" && <circle r={R_MARCA} fill={c.color} />}
      {c.forma === "hueco" && <circle r={R_MARCA - 0.5} fill={SUPERFICIE} stroke={c.color} strokeWidth={2} />}
      {c.forma === "x" && (
        <g stroke={c.color} strokeWidth={2.25} strokeLinecap="round">
          <line x1={-4} y1={-4} x2={4} y2={4} />
          <line x1={-4} y1={4} x2={4} y2={-4} />
        </g>
      )}
    </>
  );
}

/** La misma marca, en pequeño, para la leyenda HTML. */
function MuestraClase({ clase }: { clase: ClasePunto }) {
  return (
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true" className="shrink-0">
      <Marca clase={clase} />
    </svg>
  );
}

function textoPunto(p: Ubicable, d: DatosDispersion, nombreUnidad: (uid: string) => string, clic: boolean): string {
  const c = CLASES[p.clase];
  const lineas: string[] = [];
  lineas.push(`${nombreUnidad(p.unidad)} · ${fmtFecha(p.fecha)}`);
  // Se enseña lo DESPACHADO de verdad. Con combustible auxiliar el punto se dibuja a la altura de
  // la cantidad EQUIVALENTE (así km ÷ cantidad = rendimiento y cae del lado correcto de las
  // rectas), y eso se aclara para que nadie lo coteje contra el voucher.
  const cargada = esNum(p.cantidadCargada) ? p.cantidadCargada : p.cantidad;
  lineas.push(`${fmt0(p.km)} km · ${fmt2(cargada)} ${d.unidadCantidad} cargados`);
  if (p.auxiliar) lineas.push(`Se dibuja a ${fmt2(p.cantidad)} ${d.unidadCantidad} equivalentes (con la energía del combustible auxiliar)`);
  if (p.rendimiento !== null && p.rendimiento !== undefined) {
    lineas.push(`${c.etiqueta}: ${fmt1(p.rendimiento)} ${d.label}${p.auxiliar ? " *" : ""}`);
  } else {
    // El implausible ya lo dice su clase; el tramo incompleto dice POR QUÉ (bicombustible, eslabón saltado).
    const motivo = p.clase !== "implausible" && p.motivo ? ` · ${etiquetaMotivo(p.motivo)}` : "";
    lineas.push(`${c.etiqueta}${motivo}${esNum(p.crudo) ? ` (saldría ${fmt1(p.crudo)} ${d.label})` : ""}`);
  }
  if (p.auxiliar) lineas.push("* rendimiento corregido por el combustible auxiliar de la unidad");
  if (p.texto) lineas.push(p.texto);
  if (clic) lineas.push("Clic para abrir la carga.");
  return lineas.join("\n");
}

export default function Dispersion({ datos, nombreUnidad, onPunto, cargando = false }: {
  /** Lo que devuelve `dispersionDeTramos` (lib/combustible/dispersion.ts): una familia por gráfico. */
  datos: DatosDispersion;
  /** La placa (o el nombre) de una unidad a partir de su id, para el tooltip. */
  nombreUnidad: (uid: string) => string;
  /** Al tocar un punto: la carga que CIERRA el tramo. */
  onPunto?: (cargaId: number) => void;
  /** Mientras se calcula: sin puntos dice "Midiendo…" (nunca afirma un vacío); con puntos los atenúa. */
  cargando?: boolean;
}) {
  const [ref, ancho] = useAnchoMedido<HTMLDivElement>();
  const ref_ = datos.referencia;

  // Puntos que se pueden ubicar. Uno sin km o sin cantidad no debería llegar (va a `sinPunto`),
  // pero si llega se CUENTA en vez de desaparecer.
  const ubicables = datos.puntos.filter(esUbicable);
  const sinCoordenadas = datos.puntos.length - ubicables.length;

  // Conteos por clase (para la leyenda).
  const porClase = new Map<ClasePunto, number>();
  for (const p of ubicables) porClase.set(p.clase, (porClase.get(p.clase) ?? 0) + 1);
  const clasesPresentes = ORDEN_LEYENDA.filter((k) => (porClase.get(k) ?? 0) > 0);

  // Tramos sin punto, con la etiqueta de su motivo.
  const sinPunto = (Object.entries(datos.sinPunto ?? {}) as [MotivoSinRendimiento, number | undefined][])
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const totalSinPunto = sinPunto.reduce((s, [, n]) => s + (n ?? 0), 0);

  // ── Escala: desde 0 en los dos ejes (las rectas de referencia pasan por el origen) ────
  const xMaxDatos = Math.max(0, ...ubicables.map((p) => p.km));
  const yMaxDatos = Math.max(0, ...ubicables.map((p) => p.cantidad));

  const marcasX = marcasDe(xMaxDatos * 1.04);
  const marcasY = marcasDe(yMaxDatos * 1.06);
  const xMax = marcasX[marcasX.length - 1];
  const yMax = marcasY[marcasY.length - 1];

  const W = Math.max(260, ancho);
  const H = Math.round(Math.min(340, Math.max(240, W * 0.6)));
  const anchoEjeY = Math.max(...marcasY.map((m) => fmtEje(m).length)) * 6 + 10;
  const padL = anchoEjeY, padR = 12, padT = 20, padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const sx = (km: number) => padL + plotW * Math.min(1, Math.max(0, km / (xMax || 1)));
  const sy = (q: number) => padT + plotH * (1 - Math.min(1, Math.max(0, q / (yMax || 1))));

  // Lo raro va encima: se dibuja al final y su objetivo de clic gana.
  const ordenados = [...ubicables].sort((a, b) => CLASES[a.clase].orden - CLASES[b.clase].orden);

  // ── Líneas de referencia: cantidad = km ÷ rendimiento, recortadas al área del gráfico ────
  const candidatasRef: { k: string; r: unknown; rotulo: (r: number) => string; ancho: number; color: string }[] =
    ref_ && esNum(ref_.mediana) && ref_.mediana > 0
      ? [
          // Rótulos cortos (el número es el rendimiento de la recta): la leyenda de arriba dice
          // la unidad y qué significa cada lado. Largos, en un teléfono no caben los tres.
          { k: "bajo", r: ref_.bajo, rotulo: (r) => `límite ${fmt1(r)}`, ancho: 1, color: "#94a3b8" },
          { k: "mediana", r: ref_.mediana, rotulo: (r) => `mediana ${fmt1(r)}`, ancho: 1.5, color: "#475569" },
          { k: "alto", r: ref_.alto, rotulo: (r) => `límite ${fmt1(r)}`, ancho: 1, color: "#94a3b8" },
        ]
      : [];
  const lineasRef = candidatasRef.flatMap((l) => {
    if (!esNum(l.r) || l.r <= 0) return [];
    const r = l.r;
    // Donde la recta sale del área: por la derecha (km = xMax) o por arriba (cantidad = yMax).
    const qEnBorde = xMax / r;
    const porArriba = qEnBorde > yMax;
    const kmFin = porArriba ? yMax * r : xMax;
    const qFin = porArriba ? yMax : qEnBorde;
    return [{ k: l.k, r, rotulo: l.rotulo(r), ancho: l.ancho, color: l.color, x2: sx(kmFin), y2: sy(qFin), porArriba }];
  });

  // Rótulo directo en el extremo de cada recta, SOLO si cabe sin pisar a otro: la mediana
  // primero. El que no cabe no se apila ni se desplaza lejos de su recta (se leería como de
  // otra): queda en la leyenda de arriba, que nombra las tres siempre.
  type Rotulo = { k: string; x: number; y: number; anchor: "start" | "end"; texto: string };
  const rotulos: Rotulo[] = [];
  const cajas: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const k of ["mediana", "bajo", "alto"]) {
    const l = lineasRef.find((x) => x.k === k);
    if (!l) continue;
    const anchoTexto = l.rotulo.length * 5.6;
    let x: number, y: number, anchor: "start" | "end";
    if (l.porArriba) {
      y = l.y2 + 11;
      if (l.x2 + 4 + anchoTexto <= W - padR) { x = l.x2 + 4; anchor = "start"; } else { x = l.x2 - 4; anchor = "end"; }
    } else {
      x = l.x2 - 2; y = l.y2 - 5; anchor = "end";
    }
    const x0 = anchor === "start" ? x : x - anchoTexto;
    const caja = { x0, x1: x0 + anchoTexto, y0: y - 10, y1: y + 2 };
    const pisa = caja.x0 < padL || caja.y0 < 0 || cajas.some((c) => caja.x0 < c.x1 && c.x0 < caja.x1 && caja.y0 < c.y1 && c.y0 < caja.y1);
    if (pisa) continue;
    cajas.push(caja);
    rotulos.push({ k, x, y, anchor, texto: l.rotulo });
  }
  const refMediana = lineasRef.find((l) => l.k === "mediana");
  const refBajo = lineasRef.find((l) => l.k === "bajo");
  const refAlto = lineasRef.find((l) => l.k === "alto");

  const vacio = ubicables.length === 0;

  const leyenda = (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
        {clasesPresentes.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5" title={CLASES[k].ayuda}>
            <MuestraClase clase={k} />
            <span>{CLASES[k].etiqueta}</span>
            <span className="text-gray-400 tabular-nums">{porClase.get(k)}</span>
          </span>
        ))}
      </div>
      {(totalSinPunto > 0 || sinCoordenadas > 0) && (
        <p className="text-[11px] text-gray-500 leading-snug">
          {totalSinPunto > 0 && (
            <>
              <b className="text-gray-600">{totalSinPunto} tramo(s) sin punto:</b>{" "}
              {sinPunto.map(([m, n], i) => (
                <span key={m} title={textoSinPunto(m, n ?? 0)} className="cursor-help underline decoration-dotted decoration-gray-300 underline-offset-2">
                  {i > 0 && " · "}{n} {etiquetaMotivo(m)}
                </span>
              ))}
            </>
          )}
          {sinCoordenadas > 0 && (
            <span>{totalSinPunto > 0 && " — "}{sinCoordenadas} sin km o sin cantidad para ubicarlo(s)</span>
          )}
        </p>
      )}
      {refMediana && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
          <span className="inline-flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke={refMediana.color} strokeWidth={refMediana.ancho} /></svg>
            Mediana de la unidad: {fmt1(refMediana.r)} {datos.label}
            {ref_ && esNum(ref_.n) && <span className="text-gray-400">({ref_.n} tramos medidos)</span>}
          </span>
          {(refBajo || refAlto) && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke={(refBajo ?? refAlto)!.color} strokeWidth={1} /></svg>
              Límites: {refBajo && <>encima de la recta de {fmt1(refBajo.r)} = consumió de más</>}
              {refBajo && refAlto && " · "}
              {refAlto && <>debajo de la de {fmt1(refAlto.r)} = falta registrar una carga</>}
            </span>
          )}
        </div>
      )}
    </div>
  );

  // Por qué no hay rectas de referencia: lo dice el motor (`sinReferencia`), no esta pantalla.
  const notaSinReferencia = !lineasRef.length && datos.sinReferencia?.texto ? (
    <p className="text-[11px] text-gray-400 leading-snug">{datos.sinReferencia.texto}</p>
  ) : null;

  if (vacio) {
    return (
      <div ref={ref} className="space-y-2">
        {leyenda}
        <div className="h-24 flex items-center justify-center text-xs text-gray-400 bg-gray-50 rounded-xl px-4 text-center">
          {cargando ? "Midiendo…" : `Ningún tramo de este combustible tiene km y ${datos.unidadCantidad} para ubicarlo en el gráfico.`}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="space-y-2" style={{ opacity: cargando ? 0.5 : 1, transition: "opacity .2s" }}>
      {leyenda}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="group" style={{ display: "block" }}
        aria-label={`${datos.unidadCantidad} contra km por tramo: ${ubicables.length} punto(s)`}>
        <style>{`
          .afa-disp-pt { outline: none; }
          .afa-disp-pt:hover .afa-disp-anillo, .afa-disp-pt:focus-visible .afa-disp-anillo { fill: #1e293b; }
        `}</style>

        {/* Títulos de los ejes, con su unidad. */}
        <text x={0} y={11} fontSize={10} fill={TINTA_SUAVE}>{datos.unidadCantidad} del tramo</text>
        <text x={W - padR} y={H - 2} textAnchor="end" fontSize={10} fill={TINTA_SUAVE}>km del tramo</text>

        {/* Rejilla: líneas finas, sólidas y tenues. */}
        {marcasY.map((m) => (
          <g key={`y${m}`}>
            <line x1={padL} x2={W - padR} y1={sy(m)} y2={sy(m)} stroke={m === 0 ? EJE : REJILLA} strokeWidth={1} />
            <text x={padL - 6} y={sy(m) + 3} textAnchor="end" fontSize={10} fill={TINTA_SUAVE}
              style={{ fontVariantNumeric: "tabular-nums" }}>{fmtEje(m)}</text>
          </g>
        ))}
        {marcasX.map((m, i) => {
          // Rótulos del eje X sin pisarse: ~44 px por rótulo.
          const cada = Math.max(1, Math.ceil(44 / (plotW / Math.max(1, marcasX.length - 1))));
          return (
            <g key={`x${m}`}>
              <line x1={sx(m)} x2={sx(m)} y1={padT} y2={H - padB} stroke={m === 0 ? EJE : REJILLA} strokeWidth={1} />
              {i % cada === 0 && (
                <text x={sx(m)} y={H - padB + 13} textAnchor="middle" fontSize={10} fill={TINTA_SUAVE}
                  style={{ fontVariantNumeric: "tabular-nums" }}>{fmtEje(m)}</text>
              )}
            </g>
          );
        })}

        {/* Referencia de la unidad filtrada: rectas finas, rotuladas en su extremo si cabe. */}
        {lineasRef.map((l) => (
          <line key={l.k} x1={sx(0)} y1={sy(0)} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth={l.ancho} />
        ))}
        {rotulos.map((r) => (
          <text key={r.k} x={r.x} y={r.y} textAnchor={r.anchor} fontSize={10} fill={TINTA}
            stroke={SUPERFICIE} strokeWidth={3} paintOrder="stroke">
            {r.texto}
          </text>
        ))}

        {ordenados.map((p) => {
          const clic = !!onPunto;
          const titulo = textoPunto(p, datos, nombreUnidad, clic);
          // Se puede llegar con teclado a lo que hay que revisar; los normales se abren desde el
          // historial (cientos de paradas de tabulación harían inservible el teclado).
          const enfocable = clic && p.clase !== "normal";
          return (
            <g key={p.cargaId} className="afa-disp-pt" transform={`translate(${sx(p.km)},${sy(p.cantidad)})`}
              style={{ cursor: clic ? "pointer" : "default" }}
              onClick={clic ? () => onPunto!(p.cargaId) : undefined}
              tabIndex={enfocable ? 0 : undefined}
              role={enfocable ? "button" : undefined}
              aria-label={enfocable ? titulo.split("\n").slice(0, 3).join(" · ") : undefined}
              onKeyDown={enfocable ? (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPunto!(p.cargaId); }
              } : undefined}>
              <title>{titulo}</title>
              <circle r={R_TOQUE} fill="transparent" />
              <Marca clase={p.clase} />
            </g>
          );
        })}
      </svg>
      {notaSinReferencia}
    </div>
  );
}
