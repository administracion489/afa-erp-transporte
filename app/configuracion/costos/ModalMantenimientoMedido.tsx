"use client";
// La pantalla del MANTENIMIENTO medido de un tipo de vehículo.
//
// Espejo de `ModalRendimientoMedido`, y existe por lo mismo: que nadie pulse "aplicar" sin saber
// qué está firmando. Con el signo al revés, que es lo que hay que tener presente al leerlo —
// subir `mantenimiento_km` ENCARECE el S/km de la categoría y, como el margen es sobre el precio
// (`costo / (1 − margen)`, ver lib/costeo-propio.ts), sube el precio ofertado de toda cotización
// nueva de ese tipo. Un costo inflado se discute antes de vender; uno corto se descubre cuando
// el servicio ya se prestó, así que la dirección "cara" no es la peligrosa aquí — pero sigue
// siendo dinero, y sigue firmándolo una persona.
//
// Por eso NO hay botón en la celda de la tabla: `CeldaEditable` guarda en `onBlur`. El chip abre
// esto, y esto enseña la evidencia ANTES del botón. Y NUNCA hay un «usar esta» junto al número
// tecleado — mismo criterio que el PAX contratado de /programacion y el km vigente de /radar-ia.
import React, { useState } from "react";
import { componentesCostoKm, costoKmDeParametro, type ParametrosCostoKm, type PreciosCombustible } from "@/lib/costos/costo-km-parametro";
import {
  etiquetaMant, MIN_TRAMOS_MANT, DIAS_RECIENTE,
  type AgregadoMant, type PlacaMantenimiento, type MotivoFueraOt,
} from "@/lib/costos/mantenimiento-tipo";

const fmtN = (n: number, d = 2) => n.toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtS = (n: number) => `S/ ${fmtN(n)}`;
const fmtKm = (n: number) => `${n.toLocaleString("es-PE")} km`;

/** El tono del chip y de la cabecera. Se enruta por CÓDIGO, nunca olfateando el detalle. */
export const TONO_MANT: Record<string, { fg: string; bg: string; borde: string; icono: string }> = {
  medido:             { fg: "#166534", bg: "#f0fdf4", borde: "#bbf7d0", icono: "🔧" },
  coincide:           { fg: "#6b7280", bg: "#f9fafb", borde: "#e5e7eb", icono: "✓" },
  descartado:         { fg: "#6b7280", bg: "#f9fafb", borde: "#e5e7eb", icono: "🗄" },
  revisar_neumaticos: { fg: "#b45309", bg: "#fffbeb", borde: "#fde68a", icono: "⚠️" },
  varias_placas:      { fg: "#1d4ed8", bg: "#eff6ff", borde: "#bfdbfe", icono: "👥" },
  sin_placas:         { fg: "#9ca3af", bg: "#f9fafb", borde: "#e5e7eb", icono: "—" },
  sin_mantenimiento:  { fg: "#9ca3af", bg: "#f9fafb", borde: "#e5e7eb", icono: "—" },
  sin_kilometraje:    { fg: "#9ca3af", bg: "#f9fafb", borde: "#e5e7eb", icono: "—" },
  pocos_registros:    { fg: "#6b7280", bg: "#f9fafb", borde: "#e5e7eb", icono: "…" },
  solo_terceros:      { fg: "#9ca3af", bg: "#f9fafb", borde: "#e5e7eb", icono: "—" },
};

export function tonoMant(c: string) {
  return TONO_MANT[c] ?? TONO_MANT.sin_mantenimiento;
}

/** El chip de la columna MEDIDO en la categoría Mantenimiento. Es lo único que abre el modal. */
export function ChipMantenimiento({ a, onAbrir }: { a: AgregadoMant; onAbrir: () => void }) {
  const t = tonoMant(a.codigo);
  const hayQueMirar = a.medido !== null;
  return (
    <button
      onClick={onAbrir}
      title={a.detalle}
      className="text-left rounded-lg px-2 py-1 border transition-colors hover:brightness-95 w-full"
      style={{ background: t.bg, borderColor: t.borde, color: t.fg }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] leading-none">{t.icono}</span>
        {hayQueMirar
          ? <span className="font-mono font-black text-xs">{fmtN(a.medido as number)}</span>
          : <span className="text-[10px] font-bold">{etiquetaMant(a.codigo)}</span>}
      </div>
      {hayQueMirar && (
        <div className="text-[9px] font-bold mt-0.5 truncate">
          {a.codigo === "medido" && a.desvio !== null
            ? `${a.desvio > 0 ? "▲" : "▼"} ${Math.abs(a.desvio * 100).toFixed(0)} % · ver`
            : etiquetaMant(a.codigo)}
        </div>
      )}
    </button>
  );
}

// ── EL MODAL ──────────────────────────────────────────────────────────────────

function Bloque({ titulo, nota, children }: { titulo: string; nota?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
        <p className="text-[11px] font-black text-gray-500 uppercase tracking-wider">{titulo}</p>
        {nota && <p className="text-[10px] text-gray-400 mt-0.5">{nota}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

const ETIQUETA_FUERA: Record<MotivoFueraOt, string> = {
  cancelada: "anulada",
  futura: "programada",
  cabecera: "primera con kilometraje",
  sin_kilometraje: "sin kilometraje",
  tramo_implausible: "tramo no medible",
};

function FilaPlaca({ p, voto }: { p: PlacaMantenimiento; voto: string }) {
  const r = p.serie.resumen;
  return (
    <div className="flex items-baseline gap-2 flex-wrap text-xs py-1.5 border-b border-gray-50 last:border-0">
      <span className="font-mono font-black text-gray-800">{p.placa}</span>
      <span className="text-[10px] text-gray-400">{p.flota === "propia" ? "propia" : "de tercero"}</span>
      {r.soleskm !== null
        ? <span className="font-mono font-bold text-[#0b315f]">{fmtN(r.soleskm)} S/km</span>
        : <span className="text-gray-300">—</span>}
      {r.km > 0 && <span className="text-[10px] text-gray-500">{fmtS(r.costo)} en {fmtKm(r.km)} · {r.tramos} tramo(s)</span>}
      {r.desde && <span className="text-[10px] text-gray-300">{r.desde} → {r.hasta}</span>}
      <span className="ml-auto text-[10px] font-bold text-gray-400">{voto}</span>
    </div>
  );
}

export default function ModalMantenimientoMedido({
  a, parametro, precios, guardando, onAplicar, onDescartar, onCerrar,
}: {
  a: AgregadoMant;
  parametro: ParametrosCostoKm;
  precios: PreciosCombustible;
  guardando?: boolean;
  onAplicar: (nota: string) => void;
  onDescartar: (nota: string) => void;
  onCerrar: () => void;
}) {
  const [nota, setNota] = useState("");
  const t = tonoMant(a.codigo);

  // EL IMPACTO SE CALCULA CON LA MISMA FÓRMULA QUE PINTA LA TABLA DE AL LADO
  // (lib/costos/costo-km-parametro.ts). Escribir aquí un cálculo propio sería otra copia de la
  // fórmula, que es justo lo que ese módulo vino a matar.
  const antes = costoKmDeParametro(parametro, precios);
  const compAntes = componentesCostoKm(parametro, precios);
  const conMedido: ParametrosCostoKm = { ...parametro, mantenimiento_km: a.medido ?? parametro.mantenimiento_km };
  const despues = costoKmDeParametro(conMedido, precios);
  const compDespues = componentesCostoKm(conMedido, precios);
  const hayImpacto = a.medido !== null && Math.abs(despues - antes) > 0.00005;

  const fueraTodas = a.aportan.flatMap((p) => p.serie.fuera.map((f) => ({ ...f, placa: p.placa })));

  const aplicar = () => {
    if (a.medido === null) return;
    // El confirm() NOMBRA LA PLATA, no pregunta "¿estás seguro?".
    const ok = confirm(
      `${a.nombre}\n\n` +
      `Mantenimiento: ${fmtN(a.parametro)} → ${fmtN(a.medido)} S/km\n` +
      `Costo por km: S/ ${fmtN(antes, 4)} → S/ ${fmtN(despues, 4)} (${despues > antes ? "+" : ""}${fmtN(despues - antes, 4)})\n` +
      `Por cada 100 km: S/ ${fmtN(antes * 100)} → S/ ${fmtN(despues * 100)}\n\n` +
      `Esto cambia el costo —y por tanto el precio ofertado— de TODA cotización nueva de esta ` +
      `categoría. Las ya emitidas no se tocan.\n\n¿Aplicar?`
    );
    if (ok) onAplicar(nota.trim());
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onCerrar}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl my-6" onClick={(e) => e.stopPropagation()}>

        <div className="px-6 py-4 border-b flex items-start justify-between gap-4" style={{ background: t.bg }}>
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: t.fg }}>
              {t.icono} Mantenimiento medido por la flota · {etiquetaMant(a.codigo)}
            </p>
            <h3 className="font-black text-lg text-gray-900 mt-0.5">{a.nombre}</h3>
            <p className="text-[11px] text-gray-500 font-mono">{a.tipoVehiculo}</p>
          </div>
          <button onClick={onCerrar} className="text-gray-400 hover:text-gray-600 font-bold text-2xl leading-none">✕</button>
        </div>

        <div className="p-6 space-y-4">

          {/* 1 · LOS DOS NÚMEROS, CON ETIQUETAS DISTINTAS */}
          <Bloque titulo="Los dos números" nota="El de la izquierda es el que se está usando para costear. Nunca se copia uno sobre el otro solo: eso lo decides tú.">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border-2 border-gray-200 px-4 py-3">
                <p className="text-[10px] font-black text-gray-400 uppercase">Tecleado en el parámetro</p>
                <p className="font-mono font-black text-2xl text-gray-700 mt-1">{fmtN(a.parametro)}</p>
                <p className="text-[10px] text-gray-400">S/km</p>
              </div>
              <div className="rounded-xl border-2 px-4 py-3" style={{ borderColor: t.borde, background: t.bg }}>
                <p className="text-[10px] font-black uppercase" style={{ color: t.fg }}>Gastado de verdad</p>
                <p className="font-mono font-black text-2xl mt-1" style={{ color: t.fg }}>
                  {a.medido !== null ? fmtN(a.medido) : "—"}
                </p>
                <p className="text-[10px] text-gray-500">
                  {a.medido !== null ? `S/km · ${fmtS(a.soles)} en ${fmtKm(a.km)}` : "sin número"}
                </p>
              </div>
            </div>

            {a.medidoSinNeumaticos !== null && (
              <p className="text-[11px] text-amber-700 mt-2 leading-relaxed">
                Sin las órdenes que parecen compra de llantas serían{" "}
                <b className="font-mono">{fmtN(a.medidoSinNeumaticos)}</b> S/km. Este tipo ya cobra los
                neumáticos en su propio renglón, así que la diferencia entre las dos cifras es lo que se
                estaría contando <b>dos veces</b>.
              </p>
            )}

            {a.reciente !== null && a.medido !== null && Math.abs(a.reciente - a.medido) > 0.005 && (
              <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
                Últimos {DIAS_RECIENTE} días: <b className="font-mono">{fmtN(a.reciente)}</b> S/km. Se enseña,
                pero <b>no</b> es lo que se propone: el mantenimiento va a tirones y una reparación mayor
                dentro de la ventana publicaría una tasa que la unidad no hace todos los meses.
              </p>
            )}

            <p className="text-xs text-gray-600 mt-3 leading-relaxed">{a.detalle}</p>
          </Bloque>

          {/* 2 · QUIÉN LO MIDE */}
          <Bloque titulo="Quién lo mide" nota="Solo votan las unidades propias: a un tercero se le paga una factura por servicio, y su taller no es de AFA.">
            {a.aportan.length === 0 && a.observadas.length === 0
              ? <p className="text-xs text-gray-400">Ninguna unidad tiene este tipo asignado como su categoría de costeo.</p>
              : <>
                  {a.aportan.map((p) => <FilaPlaca key={p.uid} p={p} voto="cuenta" />)}
                  {a.observadas.map(({ placa, motivo }) => (
                    <div key={placa.uid} className="opacity-60">
                      <FilaPlaca p={placa} voto={`no cuenta · ${etiquetaMant(motivo)}`} />
                    </div>
                  ))}
                </>}
            <p className="text-[10px] text-gray-400 mt-2">
              Una unidad vota con {MIN_TRAMOS_MANT} tramos medidos o más. Un tramo es el trecho entre dos
              órdenes de trabajo <b>con kilometraje</b>, y su costo es el de la orden que lo cierra: el
              mantenimiento se paga después del desgaste que lo causó.
            </p>
          </Bloque>

          {/* 3 · LO QUE QUEDÓ FUERA */}
          {fueraTodas.length > 0 && (
            <Bloque titulo="Órdenes que no entraron al número" nota="Se enseñan en vez de esconderse: un dato oculto obliga a ir a buscarlo a la base.">
              <div className="flex flex-wrap gap-1.5">
                {fueraTodas.map((f, i) => (
                  <span key={i} className="text-[10px] rounded-lg border border-gray-200 bg-gray-50 px-2 py-0.5" title={f.detalle}>
                    <span className="text-gray-400">{f.placa} · {f.fecha}</span>{" "}
                    <span className="font-mono line-through text-red-400">{fmtS(f.costo)}</span>{" "}
                    <b className="text-gray-500">{ETIQUETA_FUERA[f.motivo]}</b>
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-amber-700 mt-2 leading-relaxed">
                El S/km medido es un <b>piso</b>: solo cuenta lo asentado como orden de trabajo. Un repuesto
                pagado por caja chica y nunca registrado en /mantenimiento no está en este número.
              </p>
            </Bloque>
          )}

          {/* 4 · QUIÉN HEREDA ESTE NÚMERO SIN MEDIRLO */}
          {a.heredan.length > 0 && (
            <Bloque titulo="Quién usa este número sin medirlo" nota="Estas unidades se costean con el parámetro, midan o no. Por eso el número importa más que el de una sola placa.">
              {a.heredan.map((h, i) => (
                <div key={i} className="flex items-baseline gap-2 text-xs py-1">
                  <span className="font-mono font-bold text-gray-700">{h.placa}</span>
                  <span className="text-[10px] text-gray-400">{h.motivo}</span>
                </div>
              ))}
            </Bloque>
          )}

          {/* 5 · EL IMPACTO, EN SOLES */}
          {hayImpacto && (
            <Bloque titulo="Qué mueve en soles" nota="Mismo cálculo que la tabla «Impacto en costo S/km» de la pestaña Combustible.">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-gray-400 uppercase">
                    <th className="text-left font-black pb-1">Concepto</th>
                    <th className="text-right font-black pb-1">Hoy</th>
                    <th className="text-right font-black pb-1">Con lo medido</th>
                    <th className="text-right font-black pb-1">Δ</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {[
                    ["S/km mantenimiento", compAntes.mantenimiento, compDespues.mantenimiento, 4],
                    ["S/km total", antes, despues, 4],
                    ["Por cada 100 km", antes * 100, despues * 100, 2],
                  ].map(([n, x, y, d]) => (
                    <tr key={n as string} className="border-t border-gray-50">
                      <td className="py-1.5 font-sans text-gray-600">{n as string}</td>
                      <td className="py-1.5 text-right text-gray-500">S/ {fmtN(x as number, d as number)}</td>
                      <td className="py-1.5 text-right font-black text-[#0b315f]">S/ {fmtN(y as number, d as number)}</td>
                      <td className={`py-1.5 text-right font-bold ${(y as number) > (x as number) ? "text-red-600" : "text-green-600"}`}>
                        {(y as number) > (x as number) ? "+" : ""}{fmtN((y as number) - (x as number), d as number)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
                El margen del cotizador es sobre el <b>precio</b> (<span className="font-mono">costo / (1 − margen)</span>),
                así que un costo más alto sube también el precio que se ofrece. Cambia las cotizaciones{" "}
                <b>nuevas</b> de esta categoría; las ya emitidas guardan su propio costo y no se tocan.
              </p>
            </Bloque>
          )}

          {/* PROCEDENCIA */}
          {a.procedencia.fecha && (
            <p className="text-[11px] text-gray-400">
              Último cambio de este parámetro: {String(a.procedencia.fecha).slice(0, 10)}
              {a.procedencia.por ? ` · ${a.procedencia.por}` : ""}
              {a.procedencia.origen === "medido" ? " · adoptado de una medición" : " · tecleado a mano"}
              {a.procedencia.descartado !== null && ` · medición de ${fmtN(a.procedencia.descartado)} S/km revisada y no adoptada`}
            </p>
          )}
        </div>

        {/* 6 · EL PIE */}
        <div className="px-6 py-4 border-t bg-gray-50 rounded-b-3xl space-y-3">
          {a.proponible ? (
            <>
              <input
                value={nota} onChange={(e) => setNota(e.target.value)}
                placeholder="Nota para el historial (opcional): por qué se adopta, o por qué no."
                className="w-full border border-gray-200 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-[#0b315f]"
              />
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <button
                  onClick={() => onDescartar(nota.trim())} disabled={guardando}
                  className="px-4 py-2.5 rounded-xl border border-gray-300 text-gray-600 text-sm font-bold hover:bg-white disabled:opacity-50"
                >
                  No, este número lo pongo yo
                </button>
                <button
                  onClick={aplicar} disabled={guardando}
                  className="px-5 py-2.5 rounded-xl bg-[#0b315f] text-white text-sm font-black hover:opacity-90 disabled:opacity-50"
                >
                  Aplicar {fmtN(a.parametro)} → {fmtN(a.medido as number)} S/km
                </button>
              </div>
              <p className="text-[10px] text-gray-400">
                «No, este número lo pongo yo» no cambia nada: deja constancia de que miraste esta medición, para
                que deje de proponerse hasta que se mueva.
              </p>
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-gray-500 max-w-[70%]">
                No hay nada que aplicar desde aquí. El parámetro se edita a mano en la celda de la tabla.
              </p>
              <button onClick={onCerrar} className="px-5 py-2.5 rounded-xl bg-[#0b315f] text-white text-sm font-black hover:opacity-90">
                Entendido
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
