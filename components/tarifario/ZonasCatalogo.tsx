"use client";
// components/tarifario/ZonasCatalogo.tsx — Pestaña «Zonas»: los distritos agrupados por sector,
// con sus alias (chips que se guardan al instante), su interruptor y sus subzonas debajo; y los
// puntos (geocercas). Las altas y la edición completa van en ModalZona.
//
// QUÉ ZONA LE TOCA A UNA DIRECCIÓN LO DECIDE EL MOTOR (lib/traslados/motor.ts → zonaDePunto). Aquí
// solo se editan los datos que el motor lee: el nombre y los alias de cada distrito, el centro y
// los barrios de cada subzona, el centro y el radio de cada punto.

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  coincideZona, compararSectores, mapaZonas, motivoAliasInvalido, ordenarZonas, sectorDe,
  type TarifaFila, type ZonaFila,
} from "./traslados-pantalla";
import { COLS_ZONA, filasEscritas, motivoCeroFilas, normalizarZona } from "./traslados-datos";
import { AZUL, EditorAlias, iCls, InterruptorActivo, type Decir } from "./traslados-comun";
import ModalZona, { AYUDA_ALIAS, borrarZona, REGLA_SUBZONA, type ModoModalZona } from "./ModalZona";

const ICONO = { distrito: "🏙", subzona: "↳", punto: "📍" } as const;

export default function ZonasCatalogo({ zonas, tarifas, onZona, onZonaBorrada, decir }: {
  zonas: ZonaFila[];
  tarifas: TarifaFila[];
  onZona: (z: ZonaFila) => void;
  onZonaBorrada: (id: number) => void;
  decir: Decir;
}) {
  const [q, setQ] = useState("");
  const [modal, setModal] = useState<ModoModalZona | null>(null);
  const [ocupada, setOcupada] = useState<number | null>(null);

  const porId = useMemo(() => mapaZonas(zonas), [zonas]);
  const preciosDe = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of tarifas) {
      m.set(t.zona_a_id, (m.get(t.zona_a_id) ?? 0) + 1);
      if (t.zona_b_id !== t.zona_a_id) m.set(t.zona_b_id, (m.get(t.zona_b_id) ?? 0) + 1);
    }
    return m;
  }, [tarifas]);

  /** Sectores → zonas de primer nivel (distritos y puntos) → sus subzonas, ya filtrado por la búsqueda. */
  const grupos = useMemo(() => {
    const ordenadas = ordenarZonas(zonas, porId);
    const subDe = new Map<number, ZonaFila[]>();
    for (const z of ordenadas) if (z.tipo === "subzona" && z.padre_id != null) (subDe.get(z.padre_id) ?? subDe.set(z.padre_id, []).get(z.padre_id)!).push(z);
    const porSector = new Map<string, { zona: ZonaFila; subzonas: ZonaFila[] }[]>();
    for (const z of ordenadas) {
      if (z.tipo === "subzona") continue;
      const hijas = subDe.get(z.id) ?? [];
      const propia = coincideZona(z, q, porId);
      const hijasQue = propia ? hijas : hijas.filter((s) => coincideZona(s, q, porId));
      if (!propia && hijasQue.length === 0) continue;
      const s = sectorDe(z, porId);
      (porSector.get(s) ?? porSector.set(s, []).get(s)!).push({ zona: z, subzonas: hijasQue });
    }
    // Una subzona cuyo distrito ya no existe (no debería: la base borra en cascada) se lista aparte.
    const huerfanas = ordenadas.filter((z) => z.tipo === "subzona" && (z.padre_id == null || !porId.has(z.padre_id)) && coincideZona(z, q, porId));
    return { sectores: [...porSector.entries()].sort((a, b) => compararSectores(a[0], b[0])), huerfanas };
  }, [zonas, porId, q]);

  const actualizar = async (z: ZonaFila, cambios: Partial<ZonaFila>, que: string): Promise<boolean> => {
    setOcupada(z.id);
    const r = filasEscritas<Record<string, unknown>>(await supabase.from("zonas_traslado").update(cambios).eq("id", z.id).select(COLS_ZONA), que);
    setOcupada(null);
    // Sin permiso (o con error) el estado no se toca: la pantalla sigue enseñando lo que dice la base.
    if (!r.ok) { decir(r.cero ? await motivoCeroFilas("zonas_traslado", "id", z.id, que) : r.detalle, "error"); return false; }
    onZona(normalizarZona(r.filas[0]));
    return true;
  };

  const borrar = async (z: ZonaFila) => {
    setOcupada(z.id);
    const ok = await borrarZona(z, zonas, tarifas, decir);
    setOcupada(null);
    if (ok) onZonaBorrada(z.id);
  };

  const nDistritos = zonas.filter((z) => z.tipo === "distrito").length;
  const nSub = zonas.filter((z) => z.tipo === "subzona").length;
  const nPuntos = zonas.filter((z) => z.tipo === "punto").length;

  const tarjeta = (z: ZonaFila, subzonas: ZonaFila[]) => {
    const n = preciosDe.get(z.id) ?? 0;
    const inactiva = z.activo === false;
    return (
      <div key={z.id} className={`border rounded-xl p-3 space-y-2 ${inactiva ? "bg-gray-50 border-gray-200" : "bg-white border-gray-200"}`}>
        <div className="flex items-start gap-2 flex-wrap">
          <div className="flex-1 min-w-[10rem]">
            <p className={`font-bold text-sm ${inactiva ? "text-gray-400" : "text-gray-800"}`}>
              <span aria-hidden>{ICONO[z.tipo]} </span>{z.nombre}
            </p>
            <p className="text-[10px] text-gray-400">
              {z.tipo === "punto"
                ? <>Geocerca · radio {z.radio_m ?? "?"} m · centro <span className="font-mono">{Number(z.lat).toFixed(4)}, {Number(z.lng).toFixed(4)}</span></>
                : "Distrito"}
              {" · "}{n} precio{n === 1 ? "" : "s"}
              {inactiva && " · el cotizador no la reconoce: esos pedidos pasan a un ejecutivo"}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <InterruptorActivo activo={!inactiva} ocupado={ocupada === z.id}
              titulo={inactiva ? "Inactiva: el cotizador no la reconoce y el pedido pasa a un ejecutivo. Clic para activarla." : "Activa: el cotizador la usa. Clic para desactivarla."}
              onCambiar={(v) => void actualizar(z, { activo: v }, v ? `No se pudo activar «${z.nombre}»` : `No se pudo desactivar «${z.nombre}»`)} />
            <button type="button" onClick={() => setModal({ tipo: "editar", zona: z })}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border text-gray-600 hover:bg-gray-50 min-h-[32px]" title="Editar nombre, sector, notas…">✎ Editar</button>
            {z.tipo === "distrito" && (
              <button type="button" onClick={() => setModal({ tipo: "nuevo", zonaTipo: "subzona", padre: z })}
                className="px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[#0b315f]/30 text-[#0b315f] hover:bg-[#eef3f8] min-h-[32px]">＋ Subzona</button>
            )}
          </div>
        </div>
        <EditorAlias alias={z.alias ?? []} titulo={AYUDA_ALIAS[z.tipo]} ocupado={ocupada === z.id}
          validar={(a, act) => motivoAliasInvalido(a, z, act, zonas)}
          onGuardar={(nuevo) => actualizar(z, { alias: nuevo }, `No se pudieron guardar los alias de «${z.nombre}»`)} />
        {z.notas && <p className="text-[11px] text-gray-500 italic">{z.notas}</p>}
        {subzonas.length > 0 && (
          <ul className="border-t border-dashed border-gray-200 pt-2 space-y-2">
            {subzonas.map((s) => fila(s))}
          </ul>
        )}
      </div>
    );
  };

  const fila = (s: ZonaFila) => {
    const n = preciosDe.get(s.id) ?? 0;
    const inactiva = s.activo === false;
    return (
      <li key={s.id} className={`pl-3 border-l-2 ${inactiva ? "border-gray-200" : "border-[#0b315f]/30"} space-y-1.5`}>
        <div className="flex items-start gap-2 flex-wrap">
          <div className="flex-1 min-w-[10rem]">
            <p className={`text-sm font-bold ${inactiva ? "text-gray-400" : "text-gray-700"}`}>↳ {s.nombre}</p>
            <p className="text-[10px] text-gray-400">
              Centro <span className="font-mono">{Number(s.lat).toFixed(4)}, {Number(s.lng).toFixed(4)}</span>
              {" · "}{n === 0 ? "sin precio propio: usa el de su distrito" : `${n} precio${n === 1 ? "" : "s"} propio${n === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <InterruptorActivo activo={!inactiva} ocupado={ocupada === s.id}
              titulo={inactiva ? "Inactiva: sus direcciones se cotizan con el resto del distrito. Clic para activarla." : "Activa. Clic para desactivarla."}
              onCambiar={(v) => void actualizar(s, { activo: v }, `No se pudo cambiar «${s.nombre}»`)} />
            <button type="button" onClick={() => setModal({ tipo: "editar", zona: s })}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border text-gray-600 hover:bg-gray-50 min-h-[32px]">✎ Editar</button>
            <button type="button" onClick={() => void borrar(s)} disabled={ocupada === s.id}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50 min-h-[32px]" title="Borrar la subzona (y sus precios propios)">🗑</button>
          </div>
        </div>
        <EditorAlias alias={s.alias ?? []} titulo={AYUDA_ALIAS.subzona} placeholder="＋ barrio" ocupado={ocupada === s.id}
          validar={(a, act) => motivoAliasInvalido(a, s, act, zonas)}
          onGuardar={(nuevo) => actualizar(s, { alias: nuevo }, `No se pudieron guardar los barrios de «${s.nombre}»`)} />
        {s.notas && <p className="text-[11px] text-gray-500 italic">{s.notas}</p>}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900 space-y-1">
        <p><b>Cómo se elige la zona de una dirección:</b> primero los <b>puntos</b> (geocercas como el aeropuerto: dentro del radio mandan); si no, el <b>distrito</b> que da Google, comparado completo con el nombre y los alias de cada distrito; y si el distrito tiene subzonas, la subzona. {REGLA_SUBZONA}</p>
        <p><b>Distritos que conviene partir en subzonas</b> porque el precio cambia dentro del mismo distrito: San Juan de Lurigancho, Ancón, Ventanilla, Lurín y Lurigancho (Chosica). Usa «＋ Subzona» en el distrito y marca el centro de cada parte en el mapa. Una subzona sin precio propio usa el de su distrito.</p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Buscar distrito, subzona o alias…" className={iCls("flex-1 min-w-[12rem] max-w-md")} />
        <span className="text-[11px] text-gray-400">{nDistritos} distritos · {nSub} subzonas · {nPuntos} puntos</span>
        <div className="flex gap-2 ml-auto">
          <button type="button" onClick={() => setModal({ tipo: "nuevo", zonaTipo: "distrito" })}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-700 hover:bg-gray-50 min-h-[44px]">＋ Distrito</button>
          <button type="button" onClick={() => setModal({ tipo: "nuevo", zonaTipo: "punto" })}
            className="px-4 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90 min-h-[44px]" style={{ background: AZUL }}>＋ Punto</button>
        </div>
      </div>

      {zonas.length === 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No hay zonas todavía. Para cargar los 50 distritos de Lima y Callao y el aeropuerto, corre <span className="font-mono">supabase/traslados-02-zonas-lima.sql</span> en Supabase → SQL Editor; o crea los tuyos con «＋ Distrito».
        </p>
      )}
      {zonas.length > 0 && grupos.sectores.length === 0 && grupos.huerfanas.length === 0 && (
        <p className="text-sm text-gray-500">Ninguna zona coincide con «{q.trim()}».</p>
      )}

      {grupos.sectores.map(([sector, items]) => (
        <section key={sector} className="space-y-2">
          <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">
            {sector} <span className="text-gray-300 font-bold">· {items.length}</span>
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {items.map(({ zona, subzonas }) => tarjeta(zona, subzonas))}
          </div>
        </section>
      ))}
      {grupos.huerfanas.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">Subzonas sin distrito</h3>
          <ul className="space-y-2">{grupos.huerfanas.map((s) => fila(s))}</ul>
        </section>
      )}

      {modal && (
        <ModalZona modo={modal} zonas={zonas} tarifas={tarifas} decir={decir}
          onGuardada={onZona} onBorrada={onZonaBorrada} onCerrar={() => setModal(null)} />
      )}
    </div>
  );
}
