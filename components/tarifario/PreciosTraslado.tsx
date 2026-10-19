"use client";
// components/tarifario/PreciosTraslado.tsx — Pestaña «Precios»: los precios de traslado de UNA zona
// de origen contra cada zona con la que tiene precio, por categoría de vehículo, en S/ y US$.
//
// TRES REGLAS QUE NO SE AFLOJAN:
//  · El par no tiene sentido (A↔B = B↔A) y se GUARDA con `parOrdenado` (zona_a_id <= zona_b_id):
//    es lo que exige el CHECK de la tabla y lo que el motor usa al buscar.
//  · Vaciar una celda BORRA esa fila; nunca escribe 0. Un traslado cotizado en S/ 0.00 saldría gratis.
//  · El precio que hereda una subzona (gris, «usa el de SJL») sale de `tarifaDelPar`, la misma
//    función del cotizador: lo que se ve aquí es lo que el cotizador va a usar.

import React, { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { ordenarCategorias, parOrdenado, type Moneda } from "@/lib/traslados/motor";
import {
  bloquesDePrecios, claveCelda, fmtMoneda, fmtNum, leerPrecio, mapaZonas, MONEDAS, otraPunta, SIMBOLO,
  tarifasPorZona, type CategoriaFila, type FilaPrecio, type Heredada, type TarifaFila, type ZonaFila,
} from "./traslados-pantalla";
import { COLS_TARIFA, filasEscritas, normalizarTarifa, SIN_PERMISO_TARIFAS, tarifasQueSiguen } from "./traslados-datos";
import { AZUL, BuscadorZona, Modal, SelectorZonasMultiple, iCls, type Decir } from "./traslados-comun";

const ENCABEZADO = "Precio NETO por tramo, sin IGV. Ida y retorno = 2 tramos. Soles para números peruanos (+51), dólares para el resto.";

function origenPorDefecto(zonas: readonly ZonaFila[], tarifas: readonly TarifaFila[]): number | null {
  const n = tarifasPorZona(tarifas);
  let mejor: number | null = null;
  let max = 0;
  for (const z of zonas) {
    const c = n.get(z.id) ?? 0;
    if (c > max || (c === max && c > 0 && z.tipo === "punto")) { max = c; mejor = z.id; }
  }
  return mejor ?? zonas.find((z) => z.tipo === "punto")?.id ?? null;
}

// ── Una celda (un precio en una moneda) ──────────────────────────────────────

function CeldaInput({ moneda, base, inactiva, heredada, onGuardar, onError, etiqueta, grupo }: {
  moneda: Moneda;
  base: number | null;
  inactiva: boolean;
  heredada: Heredada | null;
  onGuardar: (v: number | null) => Promise<boolean>;
  onError: (t: string) => void;
  etiqueta: string;
  grupo?: number;
}) {
  const inicial = base == null ? "" : fmtNum(base);
  const [texto, setTexto] = useState(inicial);
  const [guardando, setGuardando] = useState(false);

  const salir = async () => {
    const r = leerPrecio(texto);
    if (r.tipo === "error") { onError(`${etiqueta}: ${r.detalle}`); setTexto(inicial); return; }
    const nuevo = r.tipo === "vacio" ? null : r.valor;
    if (nuevo === base) { setTexto(inicial); return; }
    setGuardando(true);
    const ok = await onGuardar(nuevo);
    setGuardando(false);
    if (!ok) setTexto(inicial);
  };

  const titulo = [
    etiqueta,
    inactiva ? "Esta tarifa está INACTIVA: el cotizador no la usa. Escribe otro precio para reactivarla." : null,
    !texto && heredada ? heredada.titulo : null,
    grupo ? `Cambiar aquí cambia las ${grupo} zonas del grupo. Para editar una sola, sepáralas con «▸».` : null,
    "Vacío = sin precio (borra la fila). Nunca se guarda 0.",
  ].filter(Boolean).join("\n");

  return (
    <div>
      <label className={`flex items-center rounded-lg border ${guardando ? "border-blue-300 bg-blue-50" : "border-gray-200 bg-white"} focus-within:border-[#0b315f] focus-within:ring-2 focus-within:ring-[#0b315f]/15`} title={titulo}>
        <span className="pl-1.5 text-[9px] font-bold text-gray-400 w-7 flex-shrink-0">{SIMBOLO[moneda]}</span>
        <input value={texto} inputMode="decimal" aria-label={etiqueta} disabled={guardando}
          placeholder={heredada ? fmtNum(heredada.precio) : "—"}
          onChange={(e) => setTexto(e.target.value)}
          onBlur={() => void salir()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") { setTexto(inicial); (e.target as HTMLInputElement).blur(); }
          }}
          className={`w-[4.6rem] py-1.5 pr-1.5 text-right font-mono text-xs bg-transparent focus:outline-none placeholder:text-gray-300 ${inactiva && texto === inicial ? "line-through text-gray-400" : "text-gray-800 font-bold"}`} />
      </label>
      {!texto && heredada && <p className="text-[9px] text-gray-400 leading-tight mt-0.5 max-w-[6.5rem] truncate" title={heredada.titulo}>usa el de {heredada.de}</p>}
    </div>
  );
}

// ── La página de la pestaña ──────────────────────────────────────────────────

export default function PreciosTraslado({ zonas, categorias, tarifas, onTarifas, onTarifasBorradas, decir, onIrA }: {
  zonas: ZonaFila[];
  categorias: CategoriaFila[];
  tarifas: TarifaFila[];
  onTarifas: (filas: TarifaFila[]) => void;
  onTarifasBorradas: (ids: number[]) => void;
  decir: Decir;
  onIrA: (tab: "zonas" | "vehiculos") => void;
}) {
  const [origenId, setOrigenId] = useState<number | null>(() => origenPorDefecto(zonas, tarifas));
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set());
  const [agregar, setAgregar] = useState(false);

  const porId = useMemo(() => mapaZonas(zonas), [zonas]);
  const origen = origenId != null ? porId.get(origenId) ?? null : null;
  const cats = useMemo(() => ordenarCategorias(categorias), [categorias]);
  const conteo = useMemo(() => tarifasPorZona(tarifas), [tarifas]);
  const bloques = useMemo(() => (origen ? bloquesDePrecios(origen.id, zonas, tarifas, categorias) : []), [origen, zonas, tarifas, categorias]);
  const activasClaves = useMemo(() => new Set(cats.map((c) => c.clave)), [cats]);
  const ocultas = origen ? tarifas.filter((t) => otraPunta(t, origen.id) != null && !activasClaves.has(t.categoria)).length : 0;
  const propias = origen ? tarifas.filter((t) => otraPunta(t, origen.id) != null).length : 0;
  const destinosConPrecio = origen ? new Set(tarifas.map((t) => otraPunta(t, origen.id)).filter((x) => x != null)).size : 0;

  /**
   * Borra tarifas por id y lo comprueba: con RLS, un DELETE sin permiso borra cero filas sin dar
   * error. Lo que la base ya no tiene (borrado por otra persona) también se quita de la pantalla.
   * Devuelve true solo si al terminar no queda ninguna de esas filas.
   */
  const borrarTarifas = async (ids: number[], que: string): Promise<boolean> => {
    const r = filasEscritas<{ id: number }>(await supabase.from("tarifas_traslado").delete().in("id", ids).select("id"), que, ids.length);
    if (!r.ok && !r.cero) { decir(r.detalle, "error"); return false; }
    const borradas = r.ok ? r.filas.map((x) => Number(x.id)) : [];
    if (r.ok && r.faltan === 0) { onTarifasBorradas(borradas); return true; }
    const siguen = await tarifasQueSiguen(ids);
    if (siguen == null) { onTarifasBorradas(borradas); decir(`${que}: no se pudo comprobar si se borraron. Pulsa «↻ Recargar».`, "error"); return false; }
    onTarifasBorradas(ids.filter((id) => !siguen.has(id)));
    if (siguen.size === 0) return true;
    decir(`${que}: ${siguen.size} de ${ids.length} no se borraron porque ${SIN_PERMISO_TARIFAS}.`, "error");
    return false;
  };

  /** Escribe (o borra, con null) el precio de UNA celda para una o varias zonas destino. */
  const guardarPrecio = async (destinos: ZonaFila[], cat: string, moneda: Moneda, valor: number | null): Promise<boolean> => {
    if (!origen) return false;
    const pares = [...new Map(destinos.map((d) => { const p = parOrdenado(origen.id, d.id); return [`${p[0]}-${p[1]}`, p] as const; })).values()];
    const nombreCat = cats.find((c) => c.clave === cat)?.nombre ?? cat;
    if (valor == null) {
      const ids = tarifas.filter((t) => t.categoria === cat && t.moneda === moneda && pares.some(([a, b]) => t.zona_a_id === a && t.zona_b_id === b)).map((t) => t.id);
      if (ids.length === 0) return true;
      // Con RLS, un DELETE sin permiso no da error: borra cero filas. Se piden de vuelta las borradas.
      const r = await borrarTarifas(ids, `No se pudo quitar el precio ${nombreCat} ${SIMBOLO[moneda]}`);
      if (!r) return false;
      decir(`Precio ${nombreCat} ${SIMBOLO[moneda]} quitado${ids.length > 1 ? ` en ${ids.length} zonas` : ""}.`);
      return true;
    }
    const filas = pares.map(([a, b]) => ({ zona_a_id: a, zona_b_id: b, categoria: cat, moneda, precio_tramo: valor, activo: true }));
    const r = filasEscritas<Record<string, unknown>>(await supabase.from("tarifas_traslado")
      .upsert(filas, { onConflict: "zona_a_id,zona_b_id,categoria,moneda" }).select(COLS_TARIFA), `No se pudo guardar ${nombreCat} ${SIMBOLO[moneda]}`, filas.length);
    if (!r.ok) { decir(r.detalle, "error"); return false; }
    onTarifas(r.filas.map(normalizarTarifa));
    if (r.faltan > 0) { decir(`Solo se guardaron ${r.filas.length} de ${filas.length} precios ${nombreCat} ${SIMBOLO[moneda]}.`, "error"); return false; }
    decir(`${nombreCat}: ${fmtMoneda(valor, moneda)} por tramo${filas.length > 1 ? ` en ${filas.length} zonas` : ""}.`);
    return true;
  };

  const borrarFilas = async (filasP: FilaPrecio[]) => {
    if (!origen) return;
    const ids = filasP.flatMap((f) => f.exactas.map((t) => t.id));
    if (ids.length === 0) return;
    const nombres = filasP.map((f) => f.zona.nombre).join(" · ");
    const algunaSub = origen.tipo === "subzona" || filasP.some((f) => f.zona.tipo === "subzona");
    const despues = algunaSub ? "Sin precio propio, ese recorrido usará el precio de su distrito (si lo tiene)." : "Sin precio, el cotizador ya no cotiza ese recorrido solo: el pedido pasa a un ejecutivo.";
    if (!window.confirm(`¿Borrar los ${ids.length} precio${ids.length === 1 ? "" : "s"} de ${origen.nombre} ↔ ${nombres}?\n\n${despues}`)) return;
    if (!(await borrarTarifas(ids, "No se pudieron borrar los precios"))) return;
    decir(`${ids.length} precio${ids.length === 1 ? "" : "s"} borrado${ids.length === 1 ? "" : "s"}.`);
  };

  const alternar = (clave: string) => setAbiertos((s) => { const n = new Set(s); if (n.has(clave)) n.delete(clave); else n.add(clave); return n; });

  const celdas = (filasP: FilaPrecio[], claveFila: string, grupo?: number) => cats.map((c) => (
    <td key={c.clave} className="border border-gray-100 px-1.5 py-1.5 align-top">
      <div className="flex flex-col gap-1">
        {MONEDAS.map((m) => {
          const kc = claveCelda(c.clave, m);
          const primera = filasP[0].celdas[kc];
          const base = primera?.exacta ? Number(primera.exacta.precio_tramo) : null;
          const inactiva = primera?.exacta?.activo === false;
          return (
            <CeldaInput key={`${claveFila}-${kc}-${base ?? "x"}-${inactiva ? 0 : 1}`}
              moneda={m} base={base} inactiva={inactiva} heredada={grupo ? null : primera?.heredada ?? null} grupo={grupo}
              etiqueta={`${origen?.nombre ?? ""} ↔ ${filasP.map((f) => f.zona.nombre).join(" · ")} · ${c.nombre} · ${SIMBOLO[m]}`}
              onError={(t) => decir(t, "error")}
              onGuardar={(v) => guardarPrecio(filasP.map((f) => f.zona), c.clave, m, v)} />
          );
        })}
      </div>
    </td>
  ));

  const cabeceraFila = (f: FilaPrecio, extra?: React.ReactNode) => {
    const padre = f.zona.tipo === "subzona" && f.zona.padre_id != null ? porId.get(f.zona.padre_id) : undefined;
    return (
      <div className={f.nivel === 1 ? "pl-4" : ""}>
        <p className={`text-sm font-bold ${f.zona.activo === false ? "text-gray-400 line-through" : "text-gray-800"}`}>
          {f.zona.tipo === "punto" ? "📍 " : f.zona.tipo === "subzona" ? "↳ " : ""}{f.mismaZona ? `Dentro de ${f.zona.nombre}` : f.zona.nombre}
        </p>
        <p className="text-[10px] text-gray-400">
          {f.zona.tipo === "subzona" ? `subzona de ${padre?.nombre ?? "?"}` : f.zona.tipo === "punto" ? "geocerca" : f.zona.sector ?? "distrito"}
          {f.exactas.length === 0 ? " · sin precio propio" : ""}
          {f.zona.activo === false ? " · inactiva" : ""}
        </p>
        {extra}
      </div>
    );
  };

  const botonBorrar = (filasP: FilaPrecio[]) => {
    const n = filasP.reduce((s, f) => s + f.exactas.length, 0);
    return n > 0
      ? <button type="button" onClick={() => void borrarFilas(filasP)} title={`Borrar los ${n} precios de esta fila`}
          className="w-8 h-8 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 text-sm">🗑</button>
      : null;
  };

  const sticky = "border border-gray-100 px-3 py-2 sticky left-0 z-10 align-top min-w-[11rem] max-w-[14rem]";

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1 max-w-xl">
          <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Zona de origen</span>
          <BuscadorZona zonas={zonas} valor={origenId} onElegir={(id) => { setOrigenId(id); setAbiertos(new Set()); }} conteo={conteo}
            placeholder="Busca el aeropuerto, un distrito o una subzona…" />
        </div>
        <button type="button" onClick={() => setAgregar(true)} disabled={!origen || cats.length === 0}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90 disabled:opacity-40 min-h-[44px]" style={{ background: AZUL }}>
          ＋ Agregar destinos
        </button>
      </div>
      {(!origen || cats.length === 0) && (
        <p className="text-[11px] text-gray-500 -mt-2">
          {cats.length === 0 ? "«Agregar destinos» necesita al menos un vehículo activo (pestaña Vehículos)." : "«Agregar destinos» necesita una zona de origen elegida."}
        </p>
      )}

      <p className="text-xs font-bold text-[#0b315f] bg-[#eef3f8] border border-[#0b315f]/15 rounded-xl px-4 py-2.5">{ENCABEZADO}</p>

      {cats.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No hay vehículos activos, así que no hay columnas de precio.{" "}
          <button type="button" onClick={() => onIrA("vehiculos")} className="font-bold underline">Créalos en Vehículos</button>
          {" "}(AFA: <span className="font-mono">supabase/traslados-03-precios-afa.sql</span> trae los suyos).
        </div>
      ) : !origen ? (
        <p className="text-sm text-gray-500 bg-white border rounded-xl px-4 py-6 text-center">
          Elige una zona de origen para ver y editar sus precios.
          {zonas.length === 0 && <> No hay zonas: <button type="button" onClick={() => onIrA("zonas")} className="font-bold underline">créalas en Zonas</button>.</>}
        </p>
      ) : (
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
            <span><b className="text-gray-700">{origen.nombre}</b>: {destinosConPrecio} destino{destinosConPrecio === 1 ? "" : "s"} con precio propio · {propias} precio{propias === 1 ? "" : "s"}</span>
            {ocultas > 0 && <span className="text-gray-400">{ocultas} precio{ocultas === 1 ? "" : "s"} de vehículos inactivos no se muestran</span>}
          </div>
          {bloques.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500">
              {origen.nombre} todavía no tiene precios. Usa «＋ Agregar destinos» para escribirlos de una vez para varias zonas.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm border-collapse min-w-full">
                <thead>
                  <tr className="bg-gray-50">
                    <th className={`${sticky} bg-gray-50 text-left text-[11px] font-bold text-gray-500 uppercase`}>Destino</th>
                    {cats.map((c) => (
                      <th key={c.clave} className="border border-gray-100 px-2 py-2 text-left align-bottom min-w-[6.5rem]">
                        <p className="text-[11px] font-black text-gray-700 leading-tight">{c.nombre}</p>
                        <p className="text-[9px] text-gray-400 font-normal">{c.capacidad} asientos{c.maletas_bodega > 0 ? ` · bodega ${c.maletas_bodega}` : ""}</p>
                      </th>
                    ))}
                    <th className="border border-gray-100 w-10" aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {bloques.map((b) => {
                    if (b.tipo === "fila") {
                      const f = b.fila;
                      const fondo = f.nivel === 1 ? "bg-slate-50" : "bg-white";
                      return (
                        <tr key={`f-${f.zona.id}`} className={fondo}>
                          <td className={`${sticky} ${fondo}`}>{cabeceraFila(f)}</td>
                          {celdas([f], `f-${f.zona.id}`)}
                          <td className="border border-gray-100 text-center align-top pt-2">{botonBorrar([f])}</td>
                        </tr>
                      );
                    }
                    const abierto = abiertos.has(b.clave);
                    const nombres = b.filas.map((f) => f.zona.nombre).join(" · ");
                    if (!abierto) {
                      return (
                        <tr key={`g-${b.clave}`} className="bg-white">
                          <td className={`${sticky} bg-white`}>
                            <p className="text-sm font-bold text-gray-800">{nombres}</p>
                            <button type="button" onClick={() => alternar(b.clave)}
                              className="text-[10px] font-bold text-[#0b315f] hover:underline mt-0.5" title="Mismos precios en todas: se editan juntas. Sepáralas para editar una sola.">
                              ▸ {b.filas.length} zonas con los mismos precios · separar
                            </button>
                          </td>
                          {celdas(b.filas, `g-${b.clave}`, b.filas.length)}
                          <td className="border border-gray-100 text-center align-top pt-2">{botonBorrar(b.filas)}</td>
                        </tr>
                      );
                    }
                    return (
                      <React.Fragment key={`g-${b.clave}`}>
                        <tr className="bg-[#eef3f8]">
                          <td colSpan={cats.length + 2} className="px-3 py-1.5 border border-gray-100">
                            <button type="button" onClick={() => alternar(b.clave)} className="text-[10px] font-bold text-[#0b315f] hover:underline">
                              ▾ juntar {b.filas.length} zonas con los mismos precios ({nombres})
                            </button>
                          </td>
                        </tr>
                        {b.filas.map((f) => (
                          <tr key={`gf-${f.zona.id}`} className="bg-white">
                            <td className={`${sticky} bg-white`}>{cabeceraFila(f)}</td>
                            {celdas([f], `gf-${f.zona.id}`)}
                            <td className="border border-gray-100 text-center align-top pt-2">{botonBorrar([f])}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-4 py-2.5 border-t text-[10px] text-gray-400">
            Se guarda al salir de la celda. Vaciar una celda borra ese precio (nunca se guarda 0). Lo gris es el precio que una subzona hereda de su distrito: escribe uno para darle uno propio.
          </p>
        </div>
      )}

      {agregar && origen && (
        <ModalAgregarDestinos origen={origen} zonas={zonas} cats={cats} tarifas={tarifas} decir={decir}
          onGuardadas={onTarifas} onCerrar={() => setAgregar(false)} />
      )}
    </div>
  );
}

// ── «＋ Agregar destinos»: los mismos precios para varias zonas de una vez ──────

function ModalAgregarDestinos({ origen, zonas, cats, tarifas, onGuardadas, onCerrar, decir }: {
  origen: ZonaFila;
  zonas: ZonaFila[];
  cats: CategoriaFila[];
  tarifas: TarifaFila[];
  onGuardadas: (filas: TarifaFila[]) => void;
  onCerrar: () => void;
  decir: Decir;
}) {
  const [elegidas, setElegidas] = useState<Set<number>>(() => new Set());
  const [precios, setPrecios] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const porId = useMemo(() => mapaZonas(zonas), [zonas]);

  const preciosCon = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of tarifas) { const o = otraPunta(t, origen.id); if (o != null) m.set(o, (m.get(o) ?? 0) + 1); }
    return m;
  }, [tarifas, origen.id]);

  const lecturas = cats.flatMap((c) => MONEDAS.map((m) => ({ c, m, r: leerPrecio(precios[claveCelda(c.clave, m)] ?? "") })));
  const malos = lecturas.filter((x) => x.r.tipo === "error");
  const llenos = lecturas.filter((x): x is { c: CategoriaFila; m: Moneda; r: { tipo: "ok"; valor: number } } => x.r.tipo === "ok");
  const destinos = [...elegidas].map((id) => porId.get(id)).filter((z): z is ZonaFila => !!z);

  const cambios = useMemo(() => {
    const reemplaza: string[] = [];
    let iguales = 0;
    for (const z of destinos) {
      const [a, b] = parOrdenado(origen.id, z.id);
      for (const x of llenos) {
        const t = tarifas.find((y) => y.zona_a_id === a && y.zona_b_id === b && y.categoria === x.c.clave && y.moneda === x.m);
        if (!t) continue;
        if (Number(t.precio_tramo) === x.r.valor && t.activo !== false) iguales++;
        else reemplaza.push(`${z.nombre} · ${x.c.nombre}: ${fmtMoneda(Number(t.precio_tramo), x.m)} → ${fmtMoneda(x.r.valor, x.m)}`);
      }
    }
    return { reemplaza, iguales };
    // `llenos` y `destinos` se derivan de `precios` y `elegidas`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precios, elegidas, tarifas, origen.id, cats]);

  const total = destinos.length * llenos.length;
  const motivo = destinos.length === 0 ? "Marca al menos un destino."
    : malos.length > 0 ? `Revisa ${malos[0].c.nombre} ${SIMBOLO[malos[0].m]}: ${(malos[0].r as { detalle: string }).detalle}`
      : llenos.length === 0 ? "Escribe al menos un precio (los vacíos no se escriben)."
        : null;

  const guardar = async () => {
    if (motivo || guardando) return;
    if (cambios.reemplaza.length > 0) {
      const lista = cambios.reemplaza.slice(0, 6).join("\n");
      const mas = cambios.reemplaza.length > 6 ? `\n… y ${cambios.reemplaza.length - 6} más` : "";
      if (!window.confirm(`${cambios.reemplaza.length} de esos precios ya existen con otro valor y se REEMPLAZAN:\n\n${lista}${mas}\n\n¿Seguir?`)) return;
    }
    setGuardando(true);
    setError(null);
    const filas = destinos.flatMap((z) => {
      const [a, b] = parOrdenado(origen.id, z.id);
      return llenos.map((x) => ({ zona_a_id: a, zona_b_id: b, categoria: x.c.clave, moneda: x.m, precio_tramo: x.r.valor, activo: true }));
    });
    const r = filasEscritas<Record<string, unknown>>(await supabase.from("tarifas_traslado")
      .upsert(filas, { onConflict: "zona_a_id,zona_b_id,categoria,moneda" }).select(COLS_TARIFA), "No se guardaron los precios", filas.length);
    setGuardando(false);
    if (!r.ok) { setError(r.detalle); return; }
    onGuardadas(r.filas.map(normalizarTarifa));
    if (r.faltan > 0) { setError(`Solo se guardaron ${r.filas.length} de ${filas.length} precios: revisa la tabla y vuelve a intentarlo con los que faltan.`); return; }
    decir(`${filas.length} precio${filas.length === 1 ? "" : "s"} guardado${filas.length === 1 ? "" : "s"} en ${destinos.length} destino${destinos.length === 1 ? "" : "s"}.`);
    onCerrar();
  };

  return (
    <Modal titulo={`Agregar destinos desde ${origen.nombre}`} onCerrar={onCerrar} bloqueado={guardando} ancho="max-w-3xl">
      <p className="text-xs text-gray-500">Marca las zonas destino y escribe los precios una sola vez: se escribe un precio por cada zona, vehículo y moneda. Las casillas vacías no se escriben. {ENCABEZADO}</p>

      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">1 · Destinos</p>
        <SelectorZonasMultiple zonas={zonas} elegidas={elegidas} onCambiar={setElegidas}
          nota={(z) => {
            if (z.id === origen.id) return "dentro de la misma zona";
            const n = preciosCon.get(z.id) ?? 0;
            return n > 0 ? `ya tiene ${n} precio${n === 1 ? "" : "s"} con ${origen.nombre}` : null;
          }} />
      </div>

      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">2 · Precio por tramo, sin IGV</p>
        <div className="border border-gray-200 rounded-xl divide-y">
          <div className="grid grid-cols-[1fr_6rem_6rem] gap-2 px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gray-500 uppercase">
            <span>Vehículo</span><span className="text-right">S/</span><span className="text-right">US$</span>
          </div>
          {cats.map((c) => (
            <div key={c.clave} className="grid grid-cols-[1fr_6rem_6rem] gap-2 px-3 py-2 items-center">
              <span className="text-sm text-gray-700 min-w-0">
                <span className="font-bold">{c.nombre}</span>
                <span className="block text-[10px] text-gray-400">{c.capacidad} asientos{c.maletas_bodega > 0 ? ` · bodega ${c.maletas_bodega}` : ""}</span>
              </span>
              {MONEDAS.map((m) => {
                const kc = claveCelda(c.clave, m);
                const r = leerPrecio(precios[kc] ?? "");
                return (
                  <input key={m} inputMode="decimal" aria-label={`${c.nombre} ${SIMBOLO[m]}`} placeholder="—"
                    value={precios[kc] ?? ""} onChange={(e) => setPrecios((p) => ({ ...p, [kc]: e.target.value }))}
                    className={iCls(`text-right font-mono py-2 ${r.tipo === "error" ? "border-red-300 bg-red-50" : ""}`)} />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-600 space-y-1">
        <p>Se escribirán <b>{total}</b> precio{total === 1 ? "" : "s"} ({destinos.length} destino{destinos.length === 1 ? "" : "s"} × {llenos.length} casilla{llenos.length === 1 ? "" : "s"} llena{llenos.length === 1 ? "" : "s"}).</p>
        {cambios.reemplaza.length > 0 && (
          <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {cambios.reemplaza.length} ya existen con otro valor y se reemplazarán (p. ej. {cambios.reemplaza[0]}).
          </p>
        )}
        {cambios.iguales > 0 && <p className="text-gray-400">{cambios.iguales} ya tienen ese mismo precio (no cambian).</p>}
      </div>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={guardar} disabled={!!motivo || guardando}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
          {guardando ? "Guardando…" : `Guardar ${total} precio${total === 1 ? "" : "s"}`}
        </button>
        <button type="button" onClick={onCerrar} disabled={guardando} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 min-h-[44px]">Cancelar</button>
      </div>
      {motivo && <p className="text-[11px] text-gray-500">No se puede guardar todavía: {motivo}</p>}
    </Modal>
  );
}
