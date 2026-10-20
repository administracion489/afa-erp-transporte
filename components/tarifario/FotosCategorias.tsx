"use client";
// components/tarifario/FotosCategorias.tsx — Dentro de la pestaña «Vehículos»: lo que el CLIENTE ve
// de cada categoría en el PDF de la cotización de traslado (el que la IA del CRM manda por WhatsApp
// y el corporativo de /cotizaciones para esas cotizaciones): una foto exterior, una interior y la
// descripción. Columnas de traslados-07 (`foto_externa_url`, `foto_interna_url`, `descripcion_cliente`).
//
// LAS FOTOS SOLO LAS ESCRIBE EL SERVIDOR (POST/DELETE /api/traslados/categorias/foto, módulo
// «tarifas»): el bucket `traslados-fotos` no tiene ninguna política para las sesiones. Aquí se
// achican a JPEG en el navegador (foto-navegador.ts) y se comprueban con `revisarJpeg`, el mismo
// control del servidor, antes de subirlas.
//
// LA FLOTA ES SOLO UNA SUGERENCIA: las unidades vigentes cuya ficha de costeo es la de la categoría.
// Nunca se elige sola (la foto de un tercero puede mostrar su logo o su placa: REGLA DURA, el
// cliente no puede saber que la unidad es tercerizada), y la elegida se COPIA como foto nueva; las
// de Google Drive u otro sitio no se pueden copiar desde el navegador y se dice cómo subirlas.
//
// LA DESCRIPCIÓN la escribe una persona (≤ 300). Vacía, el PDF dice la frase por defecto con DATOS
// ESCRITOS (`descripcionCategoria`: asientos y bodega), que aquí se enseña tal cual saldrá.

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { faltaAlguna } from "@/lib/columna-faltante";
import { COLUMNA_FOTO, type LadoFoto } from "@/lib/traslados/fotos-categoria";
import { descripcionCategoria, MAX_DESCRIPCION_CLIENTE } from "@/lib/traslados/cotizacion-traslado";
import {
  descripcionParaGuardar, largoTexto, origenFoto, SQL_FOTOS_CATEGORIA, sugerenciasFlota,
  type CategoriaFila, type UnidadFotos,
} from "./traslados-pantalla";
import { COLS_CATEGORIA_FOTOS, filasEscritas, leerFotosFlota, motivoCeroFilas, normalizarCategoria, type FlotaFotos } from "./traslados-datos";
import { bajarFotoDeFlota, prepararFoto, quitarFotoCategoria, subirFotoCategoria } from "./foto-navegador";
import { AZUL, type Decir } from "./traslados-comun";

const NOMBRE_LADO: Record<LadoFoto, string> = { externa: "exterior", interna: "interior" };
const AVISO_CLIENTE = "El cliente verá estas fotos: que no se vea la placa, ni el nombre ni el logo de un proveedor.";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;

type EstadoFlota = null | { tipo: "cargando" } | { tipo: "listo"; propias: FlotaFotos; terceros: FlotaFotos };

const fotoDe = (c: CategoriaFila, lado: LadoFoto): string | null => {
  const v = c[COLUMNA_FOTO[lado]];
  return typeof v === "string" && v.trim() ? v : null;
};

const botonCls = "px-3 py-2 rounded-lg text-xs font-bold border min-h-[40px] disabled:opacity-40";

export default function FotosCategorias({ categorias, colsCategoria, sinMigracion: sinMigracionInicial, onCategoria, decir }: {
  /** Ya ordenadas como la tabla de arriba. */
  categorias: CategoriaFila[];
  /** Las columnas que se piden de vuelta al escribir (sin las de traslados-07 si falta la migración). */
  colsCategoria: string;
  sinMigracion: boolean;
  onCategoria: (c: CategoriaFila) => void;
  decir: Decir;
}) {
  const [sinMigracion, setSinMigracion] = useState(sinMigracionInicial);
  const [flota, setFlota] = useState<EstadoFlota>(null);
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  /** Lo que está haciendo cada foto (`CLAVE:lado`): «Preparando…», «Subiendo…». */
  const [pasos, setPasos] = useState<Record<string, string>>({});
  /** El último error de cada foto: fijo hasta la próxima acción sobre ella (un aviso que se va no se dijo). */
  const [errores, setErrores] = useState<Record<string, string>>({});

  // La versión más reciente de cada categoría: una subida que termina no puede pisar con una copia
  // vieja lo que otra acción ya cambió (el nombre, la otra foto).
  const ultimas = useRef(categorias);
  useEffect(() => { ultimas.current = categorias; });
  // Una acción a la vez por foto, también entre dos clics más rápidos que el re-render.
  const enCurso = useRef(new Set<string>());
  const reservar = (id: string) => { if (enCurso.current.has(id)) return false; enCurso.current.add(id); return true; };
  const soltar = (id: string) => { enCurso.current.delete(id); };

  const k = (clave: string, lado: LadoFoto) => `${clave}:${lado}`;
  const ponerPaso = (id: string, paso: string | null) => setPasos((p) => { const n = { ...p }; if (paso) n[id] = paso; else delete n[id]; return n; });
  const ponerError = (id: string, e: string | null) => setErrores((p) => { const n = { ...p }; if (e) n[id] = e; else delete n[id]; return n; });

  const conFoto = (clave: string, lado: LadoFoto, url: string | null) => {
    const actual = ultimas.current.find((x) => x.clave === clave);
    if (actual) onCategoria({ ...actual, [COLUMNA_FOTO[lado]]: url });
  };

  /** Achica `origen` a JPEG, lo comprueba y lo sube (la foto ya está reservada). `desde` dice de dónde salió. */
  const subirReservada = async (c: CategoriaFila, lado: LadoFoto, origen: Blob, nombre: string | null, desde: string) => {
    const id = k(c.clave, lado);
    ponerError(id, null);
    ponerPaso(id, "Preparando la foto…");
    const p = await prepararFoto(origen, nombre);
    if (!p.ok) { ponerPaso(id, null); ponerError(id, p.detalle); return; }
    ponerPaso(id, `Subiendo (${Math.ceil(p.blob.size / 1024)} KB)…`);
    const r = await subirFotoCategoria(c.clave, lado, p.blob);
    ponerPaso(id, null);
    if (!r.ok) {
      if (r.sinMigracion) setSinMigracion(true);
      ponerError(id, r.detalle);
      return;
    }
    conFoto(c.clave, lado, r.url);
    decir(`Foto ${NOMBRE_LADO[lado]} de «${c.nombre}» guardada${desde ? ` ${desde}` : ""} (${p.ancho} × ${p.alto} px).${p.pequena ? " Es una foto pequeña: en el PDF puede verse borrosa." : ""}`);
  };

  const subirArchivo = async (c: CategoriaFila, lado: LadoFoto, f: File) => {
    const id = k(c.clave, lado);
    if (!reservar(id)) return;
    try { await subirReservada(c, lado, f, f.name, ""); } finally { soltar(id); }
  };

  const quitar = async (c: CategoriaFila, lado: LadoFoto) => {
    const id = k(c.clave, lado);
    if (enCurso.current.has(id)) return;
    if (!window.confirm(`¿Quitar la foto ${NOMBRE_LADO[lado]} de «${c.nombre}»?\n\nEl PDF de las próximas cotizaciones de traslado de este vehículo saldrá sin ella (las ya enviadas no cambian).`)) return;
    if (!reservar(id)) return;
    ponerError(id, null);
    ponerPaso(id, "Quitando…");
    const r = await quitarFotoCategoria(c.clave, lado).finally(() => soltar(id));
    ponerPaso(id, null);
    if (!r.ok) {
      if (r.sinMigracion) setSinMigracion(true);
      ponerError(id, r.detalle);
      return;
    }
    conFoto(c.clave, lado, null);
    decir(`Se quitó la foto ${NOMBRE_LADO[lado]} de «${c.nombre}».`);
  };

  const usarDeFlota = async (c: CategoriaFila, u: UnidadFotos, lado: LadoFoto, url: string) => {
    const id = k(c.clave, lado);
    if (enCurso.current.has(id)) return;
    const reemplaza = fotoDe(c, lado) ? "\nReemplaza la foto que tiene ahora." : "";
    const tercero = u.flota === "tercerizada" ? `\n\nEs de una unidad TERCERIZADA: mira bien que no se vean su logo, su nombre ni su placa.` : "";
    if (!window.confirm(`¿Usar la foto ${NOMBRE_LADO[lado]} de la unidad ${u.placa} como foto ${NOMBRE_LADO[lado]} de «${c.nombre}»?${reemplaza}\n\n${AVISO_CLIENTE}${tercero}\n\nSe guarda una COPIA: si después cambia la foto de la unidad, la de la cotización no cambia.`)) return;
    if (!reservar(id)) return;
    try {
      ponerError(id, null);
      ponerPaso(id, `Bajando la foto de ${u.placa}…`);
      const b = await bajarFotoDeFlota(url);
      ponerPaso(id, null);
      if (!b.ok) { ponerError(id, b.detalle); return; }
      await subirReservada(c, lado, b.blob, null, `desde la unidad ${u.placa}`);
    } finally { soltar(id); }
  };

  const pedirFlota = () => {
    if (flota && flota.tipo !== "listo") return;
    setFlota({ tipo: "cargando" });
    void leerFotosFlota().then((r) => setFlota({ tipo: "listo", ...r }));
  };
  const alternar = (clave: string) => {
    setAbiertas((s) => { const n = new Set(s); if (n.has(clave)) n.delete(clave); else n.add(clave); return n; });
    if (flota == null) pedirFlota();
  };

  if (sinMigracion) {
    return (
      <section className="border border-amber-200 bg-amber-50 rounded-2xl p-4 space-y-1">
        <h3 className="text-sm font-bold text-amber-900">📷 Fotos y descripción para la cotización</h3>
        <p className="text-xs text-amber-900">
          Todavía no se pueden poner fotos ni la descripción para el cliente: falta correr <span className="font-mono">{SQL_FOTOS_CATEGORIA}</span> en Supabase → SQL Editor (pegar entero → Run). Hasta entonces el PDF de la cotización de traslado sale sin fotos y describe cada vehículo con la frase por defecto (asientos y bodega).
        </p>
      </section>
    );
  }

  return (
    <section className="bg-white border rounded-2xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-bold text-gray-700">📷 Fotos y descripción para la cotización</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Lo que el cliente ve de cada vehículo en el PDF de la cotización de traslado (el que la IA del CRM manda por WhatsApp; en /cotizaciones, el mismo con la plantilla corporativa): una foto exterior, una interior y una descripción. Sin fotos, el PDF sale solo con la descripción.
        </p>
      </div>
      {categorias.length === 0 && <p className="text-xs text-gray-400">No hay vehículos de traslado: créalos arriba.</p>}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {categorias.map((c) => (
          <div key={c.clave} className={`border rounded-xl p-3 space-y-3 ${c.activo === false ? "bg-gray-50" : ""}`}>
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="text-sm font-bold text-gray-800">{c.nombre || c.clave}</p>
              <span className="text-[10px] font-mono text-gray-400">{c.clave}</span>
              {c.activo === false && <span className="text-[10px] font-bold text-gray-500 bg-gray-200 rounded-full px-2 py-0.5">inactivo</span>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["externa", "interna"] as const).map((lado) => (
                <FotoSlot key={lado} categoria={c} lado={lado} url={fotoDe(c, lado)}
                  paso={pasos[k(c.clave, lado)] ?? null} error={errores[k(c.clave, lado)] ?? null}
                  onArchivo={(f) => void subirArchivo(c, lado, f)}
                  onQuitar={() => void quitar(c, lado)} />
              ))}
            </div>
            <p className="text-[11px] text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-2 py-1">{AVISO_CLIENTE}</p>
            <div>
              <button type="button" onClick={() => alternar(c.clave)} aria-expanded={abiertas.has(c.clave)}
                className="text-xs font-bold text-[#0b315f] underline min-h-[32px]">
                {abiertas.has(c.clave) ? "▾ Ocultar las fotos de la flota" : "▸ Elegir de la flota"}
              </button>
              {abiertas.has(c.clave) && (
                <SugerenciasFlota categoria={c} flota={flota} onReintentar={pedirFlota}
                  ocupado={(lado) => !!pasos[k(c.clave, lado)]}
                  onUsar={(u, lado, url) => void usarDeFlota(c, u, lado, url)} />
              )}
            </div>
            <DescripcionCliente key={c.descripcion_cliente ?? ""} categoria={c} colsCategoria={colsCategoria}
              onGuardada={onCategoria} onSinMigracion={() => setSinMigracion(true)} decir={decir} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Una foto (exterior o interior) ───────────────────────────────────────────

function FotoSlot({ categoria, lado, url, paso, error, onArchivo, onQuitar }: {
  categoria: CategoriaFila; lado: LadoFoto; url: string | null; paso: string | null; error: string | null;
  onArchivo: (f: File) => void; onQuitar: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [noCarga, setNoCarga] = useState<string | null>(null);
  const etiqueta = lado === "externa" ? "Exterior" : "Interior";
  const ocupado = !!paso;
  return (
    <div className="space-y-1.5 min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{etiqueta}</p>
      <div className="aspect-[4/3] rounded-lg border bg-gray-50 flex items-center justify-center overflow-hidden">
        {url && noCarga !== url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={`Foto ${NOMBRE_LADO[lado]} de ${categoria.nombre}`} className="w-full h-full object-contain"
            onError={() => setNoCarga(url)} />
        ) : url ? (
          <span className="text-[11px] text-amber-800 px-2 text-center">Tiene foto, pero no se pudo mostrar: vuelve a subirla.</span>
        ) : (
          <span className="text-xs text-gray-400">sin foto</span>
        )}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onArchivo(f); }} />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={ocupado} onClick={() => input.current?.click()}
          className={`${botonCls} text-white border-transparent`} style={{ background: AZUL }}>
          {url ? "Cambiar" : "Subir foto"}
        </button>
        {url && (
          <button type="button" disabled={ocupado} onClick={onQuitar} className={`${botonCls} text-red-600 border-red-200 hover:bg-red-50`}>Quitar</button>
        )}
      </div>
      {paso && <p className="text-[11px] text-gray-500" role="status">{paso}</p>}
      {error && <p className="text-[11px] text-red-700" role="alert">{error}</p>}
    </div>
  );
}

// ── Sugerencias de la flota ──────────────────────────────────────────────────

function SugerenciasFlota({ categoria, flota, ocupado, onUsar, onReintentar }: {
  categoria: CategoriaFila;
  flota: EstadoFlota;
  ocupado: (lado: LadoFoto) => boolean;
  onUsar: (u: UnidadFotos, lado: LadoFoto, url: string) => void;
  onReintentar: () => void;
}) {
  const tipo = String(categoria.tipo_vehiculo ?? "").trim();
  if (!tipo) {
    return <p className="text-xs text-gray-500 mt-1">Este vehículo no tiene <b>ficha de costeo</b>: elígela en la tabla de arriba para ver las unidades de la flota que la usan.</p>;
  }
  if (!flota || flota.tipo === "cargando") return <p className="text-xs text-gray-400 mt-1">Buscando unidades con la ficha {tipo}…</p>;

  const lecturas = [
    { nombre: "propias", r: flota.propias },
    { nombre: "tercerizadas", r: flota.terceros },
  ];
  const fallidas = lecturas.filter((l) => l.r.tipo === "error");
  const unidades = lecturas.flatMap((l) => (l.r.tipo === "ok" ? l.r.unidades : []));
  const lista = sugerenciasFlota(unidades, tipo);
  return (
    <div className="mt-2 space-y-2">
      {fallidas.map((l) => (
        <p key={l.nombre} className="text-xs text-red-700">
          No se pudieron leer las unidades {l.nombre} ({l.r.tipo === "error" ? l.r.detalle : ""}).{" "}
          <button type="button" onClick={onReintentar} className="underline font-bold">Reintentar</button>
        </p>
      ))}
      {lista.length === 0 && fallidas.length < lecturas.length && (
        <p className="text-xs text-gray-500">
          {fallidas.length ? `Entre las unidades ${lecturas.filter((l) => l.r.tipo === "ok").map((l) => l.nombre).join(" y ")}, ninguna` : "Ninguna unidad"} vigente con la ficha <span className="font-mono">{tipo}</span> tiene fotos. Sube las fotos desde tu equipo con «Subir foto».
        </p>
      )}
      {lista.map((u) => (
        <div key={`${u.flota}:${u.id}`} className="border rounded-lg p-2 space-y-1.5">
          <p className="text-xs">
            <span className="font-mono font-bold text-gray-700">{u.placa}</span>{" "}
            <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${u.flota === "propia" ? "bg-gray-100 text-gray-600" : "bg-amber-50 text-amber-800 border border-amber-200"}`}>
              {u.flota === "propia" ? "flota propia" : "tercerizada · revisa que no se vea su logo"}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(["externa", "interna"] as const).map((lado) => (
              <FotoDeUnidad key={lado} lado={lado} url={lado === "externa" ? u.foto_externa_url : u.foto_interna_url}
                ocupado={ocupado(lado)} onUsar={(url) => onUsar(u, lado, url)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FotoDeUnidad({ lado, url, ocupado, onUsar }: { lado: LadoFoto; url: string | null; ocupado: boolean; onUsar: (url: string) => void }) {
  const o = origenFoto(url, SUPABASE_URL);
  const [rota, setRota] = useState(false);
  const etiqueta = lado === "externa" ? "Exterior" : "Interior";
  if (!o) {
    return (
      <div className="text-[10px] text-gray-400">
        <p className="font-bold uppercase tracking-wide">{etiqueta}</p>
        <p>sin foto</p>
      </div>
    );
  }
  const miniatura = o.tipo === "copiable" ? o.url : o.tipo === "drive" ? o.miniatura : null;
  return (
    <div className="space-y-1 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{etiqueta}</p>
      <div className="aspect-[4/3] rounded border bg-gray-50 flex items-center justify-center overflow-hidden">
        {miniatura && !rota ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={miniatura} alt={`Foto ${NOMBRE_LADO[lado]} de la unidad`} referrerPolicy="no-referrer" className="w-full h-full object-contain"
            onError={() => setRota(true)} />
        ) : (
          <span className="text-[10px] text-gray-400 px-1 text-center">{rota ? "no se pudo mostrar" : "sin vista previa"}</span>
        )}
      </div>
      {o.tipo === "copiable" ? (
        <button type="button" disabled={ocupado || rota} onClick={() => onUsar(o.url)}
          className={`${botonCls} w-full text-[#0b315f] border-[#0b315f]/30 hover:bg-[#eef3f8]`}
          title={rota ? "La foto no se pudo mostrar: no se puede copiar." : undefined}>
          Usar como {NOMBRE_LADO[lado]}
        </button>
      ) : (
        <p className="text-[10px] text-gray-500">
          {o.tipo === "drive" ? "Está en Google Drive: no se puede copiar desde aquí." : "Está fuera del almacenamiento del ERP: no se puede copiar desde aquí."}{" "}
          Descárgala y súbela con «Subir foto».{" "}
          <a href={o.url} target="_blank" rel="noreferrer noopener" className="underline font-bold text-[#0b315f]">Abrir</a>
        </p>
      )}
    </div>
  );
}

// ── La descripción para el cliente ───────────────────────────────────────────

function DescripcionCliente({ categoria: c, colsCategoria, onGuardada, onSinMigracion, decir }: {
  categoria: CategoriaFila;
  colsCategoria: string;
  onGuardada: (c: CategoriaFila) => void;
  onSinMigracion: () => void;
  decir: Decir;
}) {
  const guardada = descripcionParaGuardar(c.descripcion_cliente);
  const [texto, setTexto] = useState(guardada ?? "");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nueva = descripcionParaGuardar(texto);
  const n = largoTexto(nueva ?? "");
  const porDefecto = descripcionCategoria({ ...c, descripcion_cliente: null });
  const motivo = nueva === guardada ? "No hay cambios."
    : n > MAX_DESCRIPCION_CLIENTE ? `Tiene ${n} caracteres y el máximo es ${MAX_DESCRIPCION_CLIENTE}.`
      : null;

  const guardar = async () => {
    if (motivo || guardando) return;
    setGuardando(true);
    setError(null);
    const que = `No se guardó la descripción de ${c.clave}`;
    const res = await supabase.from("traslado_categorias").update({ descripcion_cliente: nueva }).eq("clave", c.clave).select(colsCategoria);
    setGuardando(false);
    if (res.error && faltaAlguna(res.error, COLS_CATEGORIA_FOTOS)) { onSinMigracion(); return; }
    const r = filasEscritas<Record<string, unknown>>(res, que);
    if (!r.ok) { setError(r.cero ? await motivoCeroFilas("traslado_categorias", "clave", c.clave, que) : r.detalle); return; }
    onGuardada(normalizarCategoria(r.filas[0]));
    decir(nueva ? `Descripción de «${c.nombre}» guardada.` : `Descripción de «${c.nombre}» vaciada: el PDF usa la frase por defecto.`);
  };

  return (
    <div className="space-y-1">
      <label className="block">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Descripción para el cliente</span>
        <textarea value={texto} rows={2} onChange={(e) => { setTexto(e.target.value); if (error) setError(null); }} disabled={guardando}
          placeholder={porDefecto} aria-label={`Descripción para el cliente de ${c.clave}`}
          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f]" />
      </label>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className={n > MAX_DESCRIPCION_CLIENTE ? "text-red-700 font-bold" : "text-gray-400"}>{n}/{MAX_DESCRIPCION_CLIENTE}</span>
        <button type="button" onClick={guardar} disabled={!!motivo || guardando}
          className="px-3 py-1.5 rounded-lg font-bold text-white disabled:opacity-40 min-h-[36px]" style={{ background: AZUL }}>
          {guardando ? "Guardando…" : nueva ? "Guardar descripción" : "Guardar vacía"}
        </button>
        {nueva !== guardada && !guardando && (
          <button type="button" onClick={() => { setTexto(guardada ?? ""); setError(null); }} className="px-2 py-1.5 font-bold text-gray-500 hover:text-gray-700">Descartar</button>
        )}
        {motivo && motivo !== "No hay cambios." && <span className="text-red-700">{motivo}</span>}
      </div>
      <p className="text-[11px] text-gray-500">
        {nueva
          ? <>En el PDF: «{descripcionCategoria({ ...c, descripcion_cliente: nueva })}»</>
          : <>Vacía, el PDF dice: «{porDefecto}»</>}
      </p>
      {error && <p className="text-[11px] text-red-700" role="alert">{error}</p>}
    </div>
  );
}
