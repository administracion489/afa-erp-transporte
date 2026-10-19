"use client";
// components/tarifario/ModalZona.tsx — Alta y edición de una zona de traslado: DISTRITO (sin
// coordenadas: Huaral, Chancay…), SUBZONA (un distrito partido en partes, con su centro en el mapa)
// o PUNTO (una geocerca como el aeropuerto: centro + radio).
//
// La forma de cada tipo la exige la base (CHECK `zonas_traslado_forma`): una subzona sin centro o
// un punto sin radio no se pueden guardar, y el botón lo dice fijo debajo en vez de dejar que la
// base devuelva un error en inglés.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { leerEntero, motivoAliasInvalido, nombreRepetido, SECTORES, type TarifaFila, type ZonaFila } from "./traslados-pantalla";
import { COLS_ZONA, filasEscritas, LIMITES, motivoCeroFilas, normalizarZona } from "./traslados-datos";
import { AZUL, EditorAlias, iCls, Modal, type Decir } from "./traslados-comun";
import { LugarInput, LUGAR_VACIO, ubicarParaMapa, type LugarValor } from "./google-lugar";
import MapaZona, { type Vuelo } from "./MapaZona";
import type { TipoZona } from "@/lib/traslados/motor";

export type ModoModalZona =
  | { tipo: "nuevo"; zonaTipo: TipoZona; padre?: ZonaFila }
  | { tipo: "editar"; zona: ZonaFila };

const OTRO_SECTOR = "__otro";

export const AYUDA_ALIAS: Record<TipoZona, string> = {
  distrito: "Otros nombres con que Google o el cliente llaman al distrito (p. ej. «SJL», «Surco»). Se comparan COMPLETOS, sin tildes ni mayúsculas: «Miraflores» no reconoce «San Juan de Miraflores». «Lima» a secas nunca se agrega: Google la usa para varios distritos.",
  subzona: "Barrios que identifican la subzona (p. ej. «Canto Grande»). Si Google da ese barrio en la dirección, la dirección cae en esta subzona aunque el centro de otra esté más cerca.",
  punto: "Solo de referencia: un punto se reconoce por su geocerca (el radio en el mapa), no por el nombre.",
};

export const REGLA_SUBZONA = "Una dirección del distrito cae en la subzona cuyo centro está más cerca, salvo que Google dé el nombre de un barrio que esté en los alias de una subzona.";

/** Lo que se borra junto con una zona (la base borra en cascada subzonas y precios). */
export function mensajeBorrado(z: ZonaFila, zonas: readonly ZonaFila[], tarifas: readonly TarifaFila[]): string {
  const hijas = zonas.filter((s) => s.tipo === "subzona" && s.padre_id === z.id);
  const ids = new Set([z.id, ...hijas.map((h) => h.id)]);
  const n = tarifas.filter((t) => ids.has(t.zona_a_id) || ids.has(t.zona_b_id)).length;
  const precios = `${n} precio${n === 1 ? "" : "s"}`;
  if (z.tipo === "subzona") {
    const padre = zonas.find((p) => p.id === z.padre_id);
    return `¿Borrar la subzona «${z.nombre}»?\n\nSe borran también sus ${precios} propios. Las direcciones de esa parte volverán a cotizarse con la subzona más cercana o con el precio de ${padre?.nombre ?? "su distrito"}.`;
  }
  if (z.tipo === "punto") {
    return `¿Borrar el punto «${z.nombre}»?\n\nSe borran también sus ${precios}. Las direcciones dentro de su radio pasarán a cotizarse por su distrito.`;
  }
  return `¿Borrar el distrito «${z.nombre}»?\n\nSe borran también sus ${hijas.length} subzona${hijas.length === 1 ? "" : "s"} y ${precios} (del distrito y de sus subzonas). Las direcciones de ese distrito pasarán a un ejecutivo.\n\nSi solo quieres que el cotizador no lo use, desactívalo en vez de borrarlo.`;
}

/** Borra la zona (con confirmación que nombra lo que se va). Devuelve true si se borró. */
export async function borrarZona(z: ZonaFila, zonas: readonly ZonaFila[], tarifas: readonly TarifaFila[], decir: Decir): Promise<boolean> {
  if (!window.confirm(mensajeBorrado(z, zonas, tarifas))) return false;
  // Con RLS, un DELETE sin permiso no da error: borra cero filas. Se pide la fila de vuelta.
  const que = `No se pudo borrar «${z.nombre}»`;
  const r = filasEscritas(await supabase.from("zonas_traslado").delete().eq("id", z.id).select("id"), que);
  if (!r.ok) {
    const motivo = r.cero ? await motivoCeroFilas("zonas_traslado", "id", z.id, que) : r.detalle;
    // Ya no existía: el borrado está hecho, solo hay que reflejarlo.
    if (r.cero && /ya no existe/.test(motivo)) { decir(`«${z.nombre}» ya estaba borrada.`, "info"); return true; }
    decir(motivo, "error");
    return false;
  }
  decir(`«${z.nombre}» borrada.`);
  return true;
}

export default function ModalZona({ modo, zonas, tarifas, onGuardada, onBorrada, onCerrar, decir }: {
  modo: ModoModalZona;
  zonas: readonly ZonaFila[];
  tarifas: readonly TarifaFila[];
  onGuardada: (z: ZonaFila) => void;
  onBorrada: (id: number) => void;
  onCerrar: () => void;
  decir: Decir;
}) {
  const editando = modo.tipo === "editar" ? modo.zona : null;
  const tipo: TipoZona = editando ? editando.tipo : (modo.tipo === "nuevo" ? modo.zonaTipo : "distrito");
  const padre = useMemo(() => {
    if (modo.tipo === "nuevo") return modo.padre ?? null;
    return modo.zona.padre_id != null ? zonas.find((z) => z.id === modo.zona.padre_id) ?? null : null;
  }, [modo, zonas]);

  const sectorInicial = String(editando?.sector ?? "").trim();
  const [nombre, setNombre] = useState(() => editando?.nombre ?? (tipo === "subzona" && padre ? `${padre.nombre} · ` : ""));
  const [sectorSel, setSectorSel] = useState(() => (!sectorInicial ? "" : (SECTORES as readonly string[]).includes(sectorInicial) ? sectorInicial : OTRO_SECTOR));
  const [sectorOtro, setSectorOtro] = useState(() => ((SECTORES as readonly string[]).includes(sectorInicial) ? "" : sectorInicial));
  const [alias, setAlias] = useState<string[]>(() => [...(editando?.alias ?? [])]);
  const [notas, setNotas] = useState(() => editando?.notas ?? "");
  const [centro, setCentro] = useState<{ lat: number; lng: number } | null>(() =>
    editando && editando.lat != null && editando.lng != null ? { lat: Number(editando.lat), lng: Number(editando.lng) } : null);
  const [radio, setRadio] = useState(() => (editando?.radio_m != null ? String(editando.radio_m) : tipo === "punto" ? "1000" : ""));
  const [busca, setBusca] = useState<LugarValor>(LUGAR_VACIO);
  const [vuelo, setVuelo] = useState<Vuelo | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conMapa = tipo !== "distrito";
  const otras = useMemo(() => zonas
    .filter((z) => z.id !== editando?.id && z.lat != null && z.lng != null)
    .filter((z) => (tipo === "subzona" ? z.tipo === "subzona" && z.padre_id === padre?.id : tipo === "punto" ? z.tipo === "punto" : false))
    .map((z) => ({ id: z.id, nombre: z.nombre, lat: Number(z.lat), lng: Number(z.lng), radio_m: z.tipo === "punto" ? z.radio_m : null })),
  [zonas, editando, tipo, padre]);

  // Una subzona nueva de un distrito sin subzonas: se encuadra el distrito (best-effort; si Google no
  // responde, el mapa queda en Lima y se busca con «Ir a un lugar»).
  const buscarDistrito = tipo === "subzona" && !centro && otras.length === 0 && padre ? padre.nombre : null;
  useEffect(() => {
    if (!buscarDistrito) return;
    let vivo = true;
    void ubicarParaMapa(`${buscarDistrito}, Lima, Perú`).then((p) => {
      if (vivo && p) setVuelo({ ...p, zoom: 13, n: Date.now() });
    });
    return () => { vivo = false; };
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const borrador = { id: editando?.id ?? null, tipo, padre_id: padre?.id ?? null, nombre };
  const lecturaRadio = leerEntero(radio, LIMITES.radio_m[0], LIMITES.radio_m[1]);
  const centroValido = !!centro && Math.abs(centro.lat) <= 90 && Math.abs(centro.lng) <= 180;
  const nombreLimpio = nombre.trim();
  const repetida = nombreRepetido(nombreLimpio, zonas, editando?.id);
  const prefijo = tipo === "subzona" && padre ? `${padre.nombre} ·` : null;
  const motivo =
    !nombreLimpio ? "Falta el nombre."
      : prefijo && nombreLimpio === prefijo ? "Completa el nombre de la subzona después de «·»."
        : repetida ? `Ya existe una zona llamada «${repetida.nombre}»: los nombres no se repiten.`
          : conMapa && !centro ? "Falta marcar el centro en el mapa (haz clic donde queda)."
          : conMapa && !centroValido ? "El centro está fuera de rango: vuelve a marcarlo en el mapa."
            : tipo === "punto" && lecturaRadio.tipo !== "ok" ? `El radio va en metros: un número entero entre ${LIMITES.radio_m[0]} y ${LIMITES.radio_m[1].toLocaleString("es-PE")}.`
              : sectorSel === OTRO_SECTOR && !sectorOtro.trim() ? "Escribe el nombre del sector, o elige uno de la lista."
                : null;

  const guardar = async () => {
    if (motivo || guardando) return;
    setGuardando(true);
    setError(null);
    const sector = tipo === "subzona" ? (padre?.sector ?? null) : (sectorSel === OTRO_SECTOR ? sectorOtro.trim() : sectorSel) || null;
    const payload: Record<string, unknown> = {
      nombre: nombreLimpio,
      sector,
      alias,
      notas: notas.trim() || null,
      lat: conMapa ? centro!.lat : null,
      lng: conMapa ? centro!.lng : null,
      radio_m: tipo === "punto" && lecturaRadio.tipo === "ok" ? lecturaRadio.valor : null,
    };
    let res;
    if (editando) {
      res = await supabase.from("zonas_traslado").update(payload).eq("id", editando.id).select(COLS_ZONA);
    } else {
      const mismoTipo = zonas.filter((z) => z.tipo === tipo);
      const orden = tipo === "subzona" ? Number(padre?.orden) || 0 : Math.max(0, ...mismoTipo.map((z) => Number(z.orden) || 0)) + 1;
      res = await supabase.from("zonas_traslado").insert({ ...payload, tipo, padre_id: tipo === "subzona" ? padre?.id ?? null : null, orden, activo: true })
        .select(COLS_ZONA);
    }
    setGuardando(false);
    if (res.error?.code === "23505") {
      setError(`Ya existe una zona llamada «${nombreLimpio}» (los nombres no se repiten aunque cambien las mayúsculas).`);
      return;
    }
    // Un UPDATE sin permiso no da error con RLS: vuelve sin filas. `filasEscritas` lo dice.
    const que = editando ? "No se pudo guardar la zona" : "No se pudo crear la zona";
    const r = filasEscritas<Record<string, unknown>>(res, que);
    if (!r.ok) { setError(r.cero && editando ? await motivoCeroFilas("zonas_traslado", "id", editando.id, que) : r.detalle); return; }
    onGuardada(normalizarZona(r.filas[0]));
    decir(editando ? `«${nombreLimpio}» guardada.` : `«${nombreLimpio}» creada.`);
    onCerrar();
  };

  const borrar = async () => {
    if (!editando || guardando) return;
    setGuardando(true);
    const ok = await borrarZona(editando, zonas, tarifas, decir);
    setGuardando(false);
    if (ok) { onBorrada(editando.id); onCerrar(); }
  };

  const titulo = editando
    ? `Editar ${tipo === "punto" ? "punto" : tipo === "subzona" ? "subzona" : "distrito"} · ${editando.nombre}`
    : tipo === "subzona" ? `Nueva subzona de ${padre?.nombre ?? "?"}` : tipo === "punto" ? "Nuevo punto (geocerca)" : "Nuevo distrito";

  return (
    <Modal titulo={titulo} onCerrar={onCerrar} bloqueado={guardando} ancho="max-w-3xl">
      {tipo === "distrito" && !editando && (
        <p className="text-xs text-gray-500">Para zonas fuera de Lima (p. ej. Huaral, Chancay) o un distrito que falte. Un distrito no lleva coordenadas: se reconoce por el nombre que da Google y sus alias.</p>
      )}
      {tipo === "punto" && (
        <p className="text-xs text-gray-500">Un punto es una GEOCERCA, como el aeropuerto: una dirección dentro de su radio se cotiza como este punto aunque esté en otro distrito (manda sobre el distrito).</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block sm:col-span-2">
          <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Nombre *</span>
          <input className={iCls()} value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus
            placeholder={tipo === "subzona" ? "Ej: San Juan de Lurigancho · Canto Grande" : tipo === "punto" ? "Ej: Terminal Plaza Norte" : "Ej: Huaral"} />
        </label>
        {tipo !== "subzona" && (
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Sector</span>
            <select className={iCls()} value={sectorSel} onChange={(e) => setSectorSel(e.target.value)}>
              <option value="">— sin sector (va a «Otros») —</option>
              {SECTORES.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value={OTRO_SECTOR}>Otro… (escribirlo)</option>
            </select>
            {sectorSel === OTRO_SECTOR && (
              <input className={iCls("mt-2")} value={sectorOtro} onChange={(e) => setSectorOtro(e.target.value)} placeholder="Ej: Norte Chico" />
            )}
          </label>
        )}
        {tipo === "subzona" && padre && (
          <p className="text-xs text-gray-500 sm:col-span-2">Pertenece a <b>{padre.nombre}</b>{padre.sector ? ` (${padre.sector})` : ""}. Sin precio propio, usa el precio de su distrito.</p>
        )}
        {tipo === "punto" && (
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Radio (metros, de 1 a 10 000) *</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={radio} onChange={(e) => setRadio(e.target.value)} placeholder="1000" />
          </label>
        )}
      </div>

      <div>
        <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
          {tipo === "subzona" ? "Barrios (alias)" : "Alias"} <span className="normal-case font-normal text-gray-400" title={AYUDA_ALIAS[tipo]}>ⓘ</span>
        </span>
        <EditorAlias alias={alias} titulo={AYUDA_ALIAS[tipo]}
          placeholder={tipo === "subzona" ? "＋ barrio (Enter)" : "＋ alias (Enter)"}
          validar={(a, act) => motivoAliasInvalido(a, borrador, act, zonas)}
          onGuardar={(n) => { setAlias(n); return true; }} />
        <p className="text-[10px] text-gray-400 mt-1">{AYUDA_ALIAS[tipo]}</p>
      </div>

      {conMapa && (
        <div className="space-y-2">
          <p className="text-xs text-gray-600">
            {tipo === "subzona" ? <><b>Regla:</b> {REGLA_SUBZONA}</> : <><b>Regla:</b> dentro del radio, la dirección se cotiza como este punto.</>}
          </p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
            <div className="flex-1">
              <LugarInput valor={busca} ariaLabel="Ir a un lugar" placeholder="🔍 Ir a un lugar (barrio, avenida, terminal)…"
                onCambio={(v) => { setBusca(v); if (v.lat != null && v.lng != null) setVuelo({ lat: v.lat, lng: v.lng, zoom: 15, n: Date.now() }); }} />
            </div>
            {busca.lat != null && busca.lng != null && (
              <button type="button" onClick={() => setCentro({ lat: busca.lat!, lng: busca.lng! })}
                className="px-3 py-2.5 rounded-xl text-xs font-bold border border-[#0b315f] text-[#0b315f] hover:bg-[#eef3f8] whitespace-nowrap min-h-[44px]">
                📍 Poner el centro aquí
              </button>
            )}
          </div>
          <MapaZona centro={centro} onCentro={(lat, lng) => setCentro({ lat, lng })} otras={otras}
            radio={tipo === "punto" && lecturaRadio.tipo === "ok" ? lecturaRadio.valor : null} volarA={vuelo} />
          <p className="text-[11px] text-gray-500">
            {centro
              ? <>Centro: <span className="font-mono">{centro.lat.toFixed(5)}, {centro.lng.toFixed(5)}</span> · haz clic en otro sitio o arrastra el marcador rojo para moverlo.</>
              : "Haz clic en el mapa donde queda el centro."}
            {otras.length > 0 && ` En gris: ${tipo === "subzona" ? `las otras ${otras.length} subzona${otras.length === 1 ? "" : "s"} de ${padre?.nombre ?? "este distrito"}` : `los otros ${otras.length} punto${otras.length === 1 ? "" : "s"}`}.`}
          </p>
        </div>
      )}

      <label className="block">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Notas</span>
        <textarea className={iCls()} rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Para quien edite después (no la ve el cliente)" />
      </label>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" onClick={guardar} disabled={!!motivo || guardando}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
          {guardando ? "Guardando…" : editando ? "Guardar cambios" : "Crear"}
        </button>
        <button type="button" onClick={onCerrar} disabled={guardando} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 min-h-[44px]">Cancelar</button>
        {editando && (
          <button type="button" onClick={borrar} disabled={guardando}
            className="ml-auto px-4 py-2.5 rounded-xl font-bold text-sm text-red-600 border border-red-200 hover:bg-red-50 min-h-[44px]">🗑 Borrar</button>
        )}
      </div>
      {motivo && <p className="text-[11px] text-gray-500">No se puede guardar todavía: {motivo}</p>}
    </Modal>
  );
}
