"use client";
// La edad real de las unidades contra la ficha con la que se las deprecia.
//
// POR QUÉ ESTÁ EN LA CATEGORÍA DEPRECIACIÓN Y NO EN OTRA. `parametros_costos` deprecia con UNA
// cifra por tipo (`valor_compra`, `residual_pct`, `vida_util_anios`, `km_anio`). Eso describe
// una unidad, no dos. Cuando la misma ficha cubre un bus 0 km y otro comprado usado al 20-30 %
// de su valor, esa cifra está mal para los dos a la vez — y no hay ninguna pantalla del ERP
// donde eso se vea, porque el año de fabricación vive en /vehiculos y el valor de compra aquí.
//
// ESTE MODAL NO ESCRIBE NADA, y por eso no tiene botón: lo que hay que hacer —duplicar la
// categoría y reasignar placas— son dos acciones en dos pantallas, cada una con sus propias
// consecuencias. Lo que falta no es un clic, es la evidencia; el clic ya existe.
import React from "react";
import { componentesCostoKm, type ParametrosCostoKm, type PreciosCombustible } from "@/lib/costos/costo-km-parametro";
import { etiquetaAntiguedad, type AntiguedadTipo } from "@/lib/costos/mantenimiento-tipo";

const fmtN = (n: number, d = 2) => n.toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Solo dos códigos pintan ámbar. `coherente` y `sin_placas` no pintan NADA: un aviso que sale
 *  siempre se vuelve paisaje, y la fila ya dice todo lo demás. */
export const TONO_ANTIGUEDAD: Record<string, { fg: string; bg: string; borde: string; icono: string }> = {
  mezcla:      { fg: "#b45309", bg: "#fffbeb", borde: "#fde68a", icono: "⚠️" },
  supera_vida: { fg: "#b45309", bg: "#fffbeb", borde: "#fde68a", icono: "⚠️" },
  coherente:   { fg: "#6b7280", bg: "#f9fafb", borde: "#e5e7eb", icono: "🗓" },
  sin_anio:    { fg: "#9ca3af", bg: "#f9fafb", borde: "#e5e7eb", icono: "—" },
  sin_placas:  { fg: "#9ca3af", bg: "#f9fafb", borde: "#e5e7eb", icono: "—" },
};

export function tonoAntiguedad(c: string) {
  return TONO_ANTIGUEDAD[c] ?? TONO_ANTIGUEDAD.sin_placas;
}

/** El chip de la columna «Flota» en la categoría Depreciación. */
export function ChipAntiguedad({ x, onAbrir }: { x: AntiguedadTipo; onAbrir: () => void }) {
  const t = tonoAntiguedad(x.codigo);
  const rango = x.minAnio === null ? null : x.maxAnio !== x.minAnio ? `${x.minAnio}–${x.maxAnio}` : String(x.minAnio);
  return (
    <button
      onClick={onAbrir}
      title={x.detalle}
      className="text-left rounded-lg px-2 py-1 border transition-colors hover:brightness-95 w-full"
      style={{ background: t.bg, borderColor: t.borde, color: t.fg }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] leading-none">{t.icono}</span>
        <span className="font-mono font-black text-xs">{rango ?? "—"}</span>
      </div>
      <div className="text-[9px] font-bold mt-0.5 truncate">{etiquetaAntiguedad(x.codigo)}</div>
    </button>
  );
}

export default function ModalAntiguedadTipo({
  x, nombre, parametro, precios, onCerrar,
}: {
  x: AntiguedadTipo;
  nombre: string;
  parametro: ParametrosCostoKm;
  precios: PreciosCombustible;
  onCerrar: () => void;
}) {
  const t = tonoAntiguedad(x.codigo);
  const deprecKm = componentesCostoKm(parametro, precios).depreciacion;
  const conAnio = x.unidades.filter((u) => u.anio !== null);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onCerrar}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-6" onClick={(e) => e.stopPropagation()}>

        <div className="px-6 py-4 border-b flex items-start justify-between gap-4" style={{ background: t.bg }}>
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: t.fg }}>
              {t.icono} Edad de la flota contra su ficha · {etiquetaAntiguedad(x.codigo)}
            </p>
            <h3 className="font-black text-lg text-gray-900 mt-0.5">{nombre}</h3>
            <p className="text-[11px] text-gray-500 font-mono">{x.tipoVehiculo}</p>
          </div>
          <button onClick={onCerrar} className="text-gray-400 hover:text-gray-600 font-bold text-2xl leading-none">✕</button>
        </div>

        <div className="p-6 space-y-4">

          {/* LO QUE DICE LA FICHA */}
          <section className="rounded-2xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
              <p className="text-[11px] font-black text-gray-500 uppercase tracking-wider">Lo que dice la ficha</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Un solo juego de números para todas las unidades de esta categoría.</p>
            </div>
            <div className="p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
              {[
                ["Valor de compra", `S/ ${fmtN(parametro.valor_compra, 0)}`],
                ["Valor residual", `${fmtN(parametro.residual_pct * 100, 0)} %`],
                ["Vida útil", `${x.vidaUtil} años`],
                ["Km anuales", parametro.km_anio.toLocaleString("es-PE")],
                ["Depreciación", `S/ ${fmtN(deprecKm, 4)}/km`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-gray-100 px-2 py-2">
                  <p className="text-[9px] font-black text-gray-400 uppercase">{k}</p>
                  <p className="font-mono font-black text-sm text-[#0b315f] mt-0.5">{v}</p>
                </div>
              ))}
            </div>
          </section>

          {/* LAS UNIDADES QUE LA USAN */}
          <section className="rounded-2xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
              <p className="text-[11px] font-black text-gray-500 uppercase tracking-wider">Las unidades que la usan</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Año de fabricación de /vehiculos. Las de tercero no lo tienen: esa tabla no guarda el año.</p>
            </div>
            <div className="p-4">
              {x.unidades.length === 0
                ? <p className="text-xs text-gray-400">Ninguna unidad tiene este tipo asignado.</p>
                : x.unidades.map((u) => (
                    <div key={u.placa} className="flex items-baseline gap-2 text-xs py-1.5 border-b border-gray-50 last:border-0">
                      <span className="font-mono font-black text-gray-800">{u.placa}</span>
                      <span className="text-[10px] text-gray-400">{u.flota === "propia" ? "propia" : "de tercero"}</span>
                      {u.anio !== null
                        ? <span className="font-mono text-[#0b315f]">{u.anio} · {u.edad} año(s)</span>
                        : <span className="text-[10px] text-gray-300">sin año de fabricación</span>}
                      {u.superaVida && (
                        <span className="ml-auto text-[10px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          superó los {x.vidaUtil} años de la ficha
                        </span>
                      )}
                    </div>
                  ))}
              {x.sinAnio > 0 && conAnio.length > 0 && (
                <p className="text-[10px] text-gray-400 mt-2">
                  {x.sinAnio} unidad(es) sin año de fabricación no entran en la comparación. Se llena en
                  /vehiculos → Editar → Año.
                </p>
              )}
            </div>
          </section>

          {/* EL VEREDICTO */}
          {x.detalle && (
            <div className="rounded-2xl px-4 py-3 border" style={{ background: t.bg, borderColor: t.borde }}>
              <p className="text-xs leading-relaxed" style={{ color: x.codigo === "coherente" ? "#4b5563" : t.fg }}>
                {x.detalle}
              </p>
            </div>
          )}

          {/* LO QUE HAY QUE HACER, CUANDO HAY ALGO QUE HACER */}
          {(x.codigo === "mezcla" || x.codigo === "supera_vida") && (
            <section className="rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                <p className="text-[11px] font-black text-gray-500 uppercase tracking-wider">Cómo se separa</p>
              </div>
              <div className="p-4 text-xs text-gray-600 space-y-2 leading-relaxed">
                <p><b>1 ·</b> Duplica la categoría con <b>➕ Agregar vehículo</b>: una <b>{"Premium (<10 años)"}</b> y una <b>{"Estándar (>10 años)"}</b>.</p>
                <p><b>2 ·</b> En la estándar, cuatro números cambian y <b>no solo uno</b>: el <b>valor de compra</b> es lo que se pagó de verdad (no el 0 km), la <b>vida útil</b> es la que le QUEDA (no 10 años otra vez), el <b>residual</b> es un % de lo que se pagó, y el <b>mantenimiento S/km</b> sube — esa es la columna Medido de la categoría 🔧 Mantenimiento.</p>
                <p><b>3 ·</b> Reasigna cada placa en <b>/vehiculos → Editar → Categoría de costeo</b>.</p>
                <p className="text-amber-700">
                  Bajar solo la depreciación deja la categoría usada más barata de lo que es: el ahorro de
                  capital se lo come un mantenimiento más caro, y el ERP ofertaría por debajo del costo real.
                </p>
                <p className="text-gray-400">
                  La depreciación exacta de una placa concreta vive en <span className="font-mono">activos_fijos</span> y
                  manda sobre este parámetro en el presupuesto de cada servicio. Esta ficha es el default del
                  cotizador, que es donde se vende.
                </p>
              </div>
            </section>
          )}
        </div>

        <div className="px-6 py-4 border-t bg-gray-50 rounded-b-3xl flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-500 max-w-[70%]">
            Esta pantalla no escribe nada: cruza el año de tus unidades con la vida útil que declara la ficha.
          </p>
          <button onClick={onCerrar} className="px-5 py-2.5 rounded-xl bg-[#0b315f] text-white text-sm font-black hover:opacity-90">
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
