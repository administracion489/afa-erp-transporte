"use client";
// components/licitaciones/editor/contenido/EditorBloque.tsx — Un bloque de una sección: su tarjeta (asa,
// tipo, acciones, hallazgos que lo nombran) y el editor de cada uno de los ocho tipos.
//
// El bloque AUTOMÁTICO no se escribe: se elige qué tabla arma el ERP, y la vista previa que se enseña es
// la del MISMO resolvedor que usa el PDF (resolverDocumento), no una copia.

import { useState, type ReactNode } from "react";
import { TIPOS_AUTO, type ArchivoRef, type Bloque, type BloqueResuelto, type Hallazgo, type Paso, type TipoAuto, type TipoBloque } from "@/lib/licitaciones/tipos";
import type { ValoresVariables } from "@/lib/licitaciones/texto";
import { Boton, BotonIcono, CampoTexto, Campo, Interruptor, MiniaturaDoc, TextoVista, TopeAlcanzado, claseInput } from "./comun";
import EditorTabla from "./EditorTabla";
import { useSortable } from "@dnd-kit/sortable";
import { Asa, estiloOrdenable } from "./ordenable";
import { INFO_AUTO, INFO_BLOQUE, LIM, ORDEN_TIPOS } from "./bloques";

/** La vista previa de las tablas automáticas de una sección (resolverDocumento). «inactiva»: la sección no se imprime. */
export type VistaAuto = { estado: "cargando" } | { estado: "inactiva" } | { estado: "error"; detalle: string } | { estado: "ok"; bloques: BloqueResuelto[] };
type Aviso = (texto: string, tono?: "ok" | "error" | "aviso") => void;

const COLOR_GRAVEDAD: Record<Hallazgo["gravedad"], string> = {
  alarma: "text-red-700 bg-red-50 border-red-200",
  aviso: "text-amber-800 bg-amber-50 border-amber-200",
  info: "text-gray-600 bg-gray-50 border-gray-200",
};

// ══ Menú de tipos ═══════════════════════════════════════════════════════════════

/** Los ocho tipos de bloque; el automático se elige directamente por su tabla. */
export function MenuTipos({ elegir, cerrar, alinear = "izq" }: { elegir: (t: TipoBloque, auto?: TipoAuto) => void; cerrar: () => void; alinear?: "izq" | "der" }) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={cerrar} aria-hidden />
      <div role="menu" className={`fixed inset-x-4 top-20 z-40 max-h-[70vh] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-lg sm:absolute sm:inset-x-auto sm:top-auto sm:mt-1 sm:w-[22rem] ${alinear === "der" ? "sm:right-0" : "sm:left-0"}`}>
        {ORDEN_TIPOS.filter((t) => t !== "auto").map((t) => (
          <button key={t} type="button" role="menuitem" onClick={() => elegir(t)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-50">
            <span className="w-5 shrink-0 text-center text-gray-500">{INFO_BLOQUE[t].icono}</span>
            <span className="min-w-0"><span className="block text-sm font-medium text-gray-800">{INFO_BLOQUE[t].nombre}</span><span className="block text-[11px] text-gray-500">{INFO_BLOQUE[t].ayuda}</span></span>
          </button>
        ))}
        <div className="mt-1 border-t border-gray-100 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">⚙ Tabla automática (la arma el ERP)</div>
        {TIPOS_AUTO.map((a) => (
          <button key={a} type="button" role="menuitem" onClick={() => elegir("auto", a)} className="block w-full rounded-lg px-2 py-1.5 pl-9 text-left hover:bg-gray-50">
            <span className="block text-sm text-gray-800">{INFO_AUTO[a].nombre}</span>
            <span className="block text-[11px] text-gray-500">{INFO_AUTO[a].descripcion}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ══ Tarjeta del bloque ══════════════════════════════════════════════════════════

export type PropsBloque = {
  bloque: Bloque;
  indice: number;
  total: number;
  /** Número que se imprimirá (subtítulos numerados). */
  numero: string | null;
  cambiar: (fn: (b: Bloque) => Bloque) => void;
  mover: (d: -1 | 1) => void;
  duplicar: () => void;
  quitar: () => void;
  insertarDebajo: (t: TipoBloque, auto?: TipoAuto) => void;
  /** false al llegar al tope de bloques de la sección (duplicar e insertar se apagan). */
  puedeAgregar: boolean;
  soloLectura: boolean;
  valores: ValoresVariables | null;
  aviso: Aviso;
  subirImagen: (file: File) => Promise<ArchivoRef>;
  irA: (paso: Paso, ancla?: string | null) => void;
  vistaAuto: VistaAuto | null;
  hallazgos: Hallazgo[];
  resaltado: boolean;
  /** id del elemento (anclaDe("bloque", id)). */
  domId: string;
};

export default function EditorBloque(p: PropsBloque) {
  const { bloque: b, soloLectura } = p;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: b.id, disabled: soloLectura });
  const [menu, setMenu] = useState(false);
  const info = INFO_BLOQUE[b.tipo];
  const nombre = b.tipo === "auto" ? `Tabla automática · ${INFO_AUTO[b.auto].nombre}` : info.nombre;
  const abiertos = p.hallazgos.filter((h) => !h.aceptado);

  return (
    <div ref={setNodeRef} style={estiloOrdenable({ transform, transition, isDragging })} id={p.domId}
      className={`min-w-0 scroll-mt-24 rounded-xl border bg-white transition-shadow ${p.resaltado ? "border-amber-400 ring-2 ring-amber-300" : "border-gray-200"} ${isDragging ? "shadow-lg" : ""}`}>
      <div className="flex items-center gap-1 border-b border-gray-100 px-1.5 py-1">
        {!soloLectura ? <Asa atributos={attributes} escuchas={listeners} etiqueta={nombre} /> : null}
        <span className="w-5 shrink-0 text-center text-xs text-gray-400">{info.icono}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-600">
          {nombre}{p.numero ? <span className="ml-1 font-mono text-[#0b315f]">{p.numero}</span> : null}
        </span>
        {abiertos.length ? (
          <span className={`shrink-0 rounded-full border px-1.5 text-[10px] font-semibold ${COLOR_GRAVEDAD[abiertos.some((h) => h.gravedad === "alarma") ? "alarma" : abiertos.some((h) => h.gravedad === "aviso") ? "aviso" : "info"]}`}
            title={abiertos.map((h) => h.texto).join("\n")}>
            ⚠ {abiertos.length}<span className="hidden sm:inline"> {abiertos.length === 1 ? "observación" : "observaciones"}</span>
          </span>
        ) : null}
        {!soloLectura ? (
          <div className="flex shrink-0 items-center">
            <BotonIcono title="Subir el bloque" disabled={p.indice === 0} onClick={() => p.mover(-1)}>↑</BotonIcono>
            <BotonIcono title="Bajar el bloque" disabled={p.indice === p.total - 1} onClick={() => p.mover(1)}>↓</BotonIcono>
            <div className="relative">
              <BotonIcono title={p.puedeAgregar ? "Insertar un bloque debajo" : "La sección llegó al tope de bloques"} disabled={!p.puedeAgregar} onClick={() => setMenu((m) => !m)}>＋</BotonIcono>
              {menu ? <MenuTipos alinear="der" cerrar={() => setMenu(false)} elegir={(t, a) => { setMenu(false); p.insertarDebajo(t, a); }} /> : null}
            </div>
            <BotonIcono title={p.puedeAgregar ? "Duplicar el bloque" : "La sección llegó al tope de bloques"} disabled={!p.puedeAgregar} onClick={p.duplicar}>⧉</BotonIcono>
            <BotonIcono title="Quitar el bloque" peligro onClick={p.quitar}>✕</BotonIcono>
          </div>
        ) : null}
      </div>
      {abiertos.length ? (
        <ul className="space-y-0.5 border-b border-gray-100 px-3 py-1.5">
          {abiertos.slice(0, 3).map((h) => (
            <li key={h.clave} className={`text-[11px] ${h.gravedad === "alarma" ? "text-red-700" : h.gravedad === "aviso" ? "text-amber-800" : "text-gray-600"}`}>• {h.texto}</li>
          ))}
          {abiertos.length > 3 ? <li className="text-[11px] text-gray-500">y {abiertos.length - 3} más (arriba, en Observaciones del contenido).</li> : null}
        </ul>
      ) : null}
      <div className="p-3">
        <CuerpoBloque {...p} />
      </div>
    </div>
  );
}

function CuerpoBloque(p: PropsBloque) {
  const { bloque: b, cambiar, soloLectura, valores, aviso } = p;
  switch (b.tipo) {
    case "parrafo":
      return (
        <CampoTexto multilinea filas={4} valor={b.texto} max={LIM.texto} valores={valores} soloLectura={soloLectura} aviso={aviso}
          placeholder="Escribe el párrafo. **así** sale en negrita."
          cambiar={(texto) => cambiar((x) => (x.tipo === "parrafo" ? { ...x, texto } : x))} />
      );
    case "subtitulo":
      return (
        <div className="space-y-2">
          <CampoTexto valor={b.texto} max={LIM.subtitulo} valores={valores} soloLectura={soloLectura} aviso={aviso} placeholder="Título del apartado"
            className="font-semibold" cambiar={(texto) => cambiar((x) => (x.tipo === "subtitulo" ? { ...x, texto } : x))} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              Nivel
              <select value={b.nivel} disabled={soloLectura} onChange={(e) => cambiar((x) => (x.tipo === "subtitulo" ? { ...x, nivel: e.target.value === "3" ? 3 : 2 } : x))}
                className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-sm">
                <option value={2}>2 · apartado (1.1)</option>
                <option value={3}>3 · sub-apartado (1.1.1)</option>
              </select>
            </label>
            <Interruptor marcado={b.numerado} disabled={soloLectura} cambiar={(numerado) => cambiar((x) => (x.tipo === "subtitulo" ? { ...x, numerado } : x))}>Numerado</Interruptor>
            <span className="text-xs text-gray-500">
              {b.numerado ? (p.numero ? `Se imprime como ${p.numero}.` : "Sin número: la sección no está numerada o está desactivada.") : "Sin número."}
              {b.nivel === 2 ? " Entra en el índice si el índice muestra dos niveles." : ""}
            </span>
          </div>
        </div>
      );
    case "vinetas": {
      const valor = b.items.join("\n");
      const llenas = b.items.filter((i) => i.trim()).length;
      return (
        <div className="space-y-2">
          <CampoTexto multilinea filas={4} valor={valor} max={LIM.vinetas * 400} valores={valores} soloLectura={soloLectura} aviso={aviso}
            placeholder={"Una viñeta por línea\nOtra viñeta"}
            cambiar={(v) => cambiar((x) => (x.tipo === "vinetas" ? { ...x, items: v.split("\n").slice(0, LIM.vinetas).map((i) => i.slice(0, LIM.texto)) } : x))} />
          <div className="flex flex-wrap items-center gap-3">
            <Interruptor marcado={b.ordenada} disabled={soloLectura} cambiar={(ordenada) => cambiar((x) => (x.tipo === "vinetas" ? { ...x, ordenada } : x))}>Numerada (1, 2, 3…)</Interruptor>
            <span className="text-xs text-gray-500">{llenas} {llenas === 1 ? "viñeta" : "viñetas"}. Las líneas vacías no se imprimen.</span>
          </div>
          {b.items.length >= LIM.vinetas ? <TopeAlcanzado>La lista llegó al tope de {LIM.vinetas} viñetas: lo que siga se pierde. Divídela en dos listas.</TopeAlcanzado> : null}
        </div>
      );
    }
    case "tabla":
      return (
        <div className="space-y-2">
          <Campo etiqueta="Título de la tabla (opcional)">
            <input value={b.titulo ?? ""} readOnly={soloLectura} maxLength={LIM.tituloTabla} placeholder="Sin título"
              onChange={(e) => cambiar((x) => (x.tipo === "tabla" ? { ...x, titulo: e.target.value.trim() ? e.target.value : null } : x))} className={claseInput} />
          </Campo>
          <EditorTabla tabla={{ columnas: b.columnas, filas: b.filas, anchos: b.anchos }} soloLectura={soloLectura} aviso={aviso}
            cambiar={(t) => cambiar((x) => (x.tipo === "tabla" ? { ...x, ...t } : x))} />
        </div>
      );
    case "nota":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3">
            {(["info", "aviso"] as const).map((t) => (
              <label key={t} className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" className="accent-[#0b315f]" checked={b.tono === t} disabled={soloLectura} onChange={() => cambiar((x) => (x.tipo === "nota" ? { ...x, tono: t } : x))} />
                <span className={`rounded px-1.5 text-xs ${t === "info" ? "bg-sky-50 text-sky-800" : "bg-amber-50 text-amber-800"}`}>{t === "info" ? "Informativa (azul)" : "Advertencia (ámbar)"}</span>
              </label>
            ))}
          </div>
          <CampoTexto multilinea filas={3} valor={b.texto} max={LIM.texto} valores={valores} soloLectura={soloLectura} aviso={aviso} placeholder="El dato que no se debe pasar por alto"
            cambiar={(texto) => cambiar((x) => (x.tipo === "nota" ? { ...x, texto } : x))} />
        </div>
      );
    case "imagen":
      return <EditorImagen {...p} />;
    case "salto_pagina":
      return <p className="text-xs text-gray-500">Lo que sigue a este bloque empieza en una hoja nueva del PDF.</p>;
    case "auto":
      return <EditorAuto {...p} />;
  }
}

// ══ Imagen ══════════════════════════════════════════════════════════════════════

function EditorImagen(p: PropsBloque) {
  const { bloque: b, cambiar, soloLectura, subirImagen } = p;
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (b.tipo !== "imagen") return null;
  const subir = async (file: File | undefined) => {
    if (!file) return;
    setSubiendo(true); setError(null);
    try {
      const ref = await subirImagen(file);
      cambiar((x) => (x.tipo === "imagen" ? { ...x, archivo: ref } : x));
      p.aviso(`Imagen «${ref.nombre}» subida.`, "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo subir la imagen.");
    } finally {
      setSubiendo(false);
    }
  };
  const elegir = (texto: ReactNode) => (
    <label className={`inline-flex min-h-9 cursor-pointer items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 ${subiendo ? "pointer-events-none opacity-50" : ""}`}>
      {subiendo ? "Subiendo…" : texto}
      <input type="file" accept="image/png,image/jpeg" className="sr-only" disabled={subiendo} onChange={(e) => { void subir(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );
  return (
    <div className="space-y-3">
      {b.archivo ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex max-w-full shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 p-1 sm:w-56">
            <MiniaturaDoc url={b.archivo.url} alt={b.pie ?? b.archivo.nombre} className="max-h-48 max-w-full object-contain" />
          </div>
          <div className="min-w-0 space-y-2 text-xs text-gray-600">
            <p className="break-all"><span className="font-semibold text-gray-700">{b.archivo.nombre}</span> · {(b.archivo.bytes / 1024).toFixed(0)} KB</p>
            {!soloLectura ? (
              <div className="flex flex-wrap gap-1.5">
                {elegir("Cambiar la imagen")}
                <Boton tam="sm" tono="peligro" onClick={() => { if (window.confirm(`¿Quitar la imagen «${b.archivo?.nombre}» del bloque? (el bloque queda sin imagen)`)) cambiar((x) => (x.tipo === "imagen" ? { ...x, archivo: null } : x)); }}>Quitar la imagen</Boton>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/50 p-4 text-center">
          <p className="mb-2 text-sm text-amber-900">Este bloque no tiene imagen: en el PDF no sale nada hasta que la subas.</p>
          {!soloLectura ? elegir("Subir PNG o JPG") : null}
        </div>
      )}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_14rem]">
        <Campo etiqueta="Pie de la imagen (opcional)">
          <input value={b.pie ?? ""} readOnly={soloLectura} maxLength={LIM.pieImagen} placeholder="Figura 1. …"
            onChange={(e) => cambiar((x) => (x.tipo === "imagen" ? { ...x, pie: e.target.value.trim() ? e.target.value : null } : x))} className={claseInput} />
        </Campo>
        <Campo etiqueta={`Ancho: ${b.anchoPct} % del ancho útil`}>
          <input type="range" min={10} max={100} step={5} value={b.anchoPct} disabled={soloLectura}
            onChange={(e) => cambiar((x) => (x.tipo === "imagen" ? { ...x, anchoPct: Math.min(100, Math.max(10, Number(e.target.value) || 100)) } : x))}
            className="h-8 w-full accent-[#0b315f]" />
        </Campo>
      </div>
    </div>
  );
}

// ══ Automático ══════════════════════════════════════════════════════════════════

const MAX_FILAS_VISTA = 10;

function EditorAuto(p: PropsBloque) {
  const { bloque: b, cambiar, soloLectura, aviso, irA, vistaAuto, valores } = p;
  const [extraAbierto, setExtraAbierto] = useState(false);
  if (b.tipo !== "auto") return null;
  const info = INFO_AUTO[b.auto];
  const tabla = vistaAuto?.estado === "ok" ? vistaAuto.bloques.find((x): x is Extract<BloqueResuelto, { tipo: "tabla" }> => x.tipo === "tabla" && x.id === b.id) ?? null : null;
  const intro = vistaAuto?.estado === "ok" ? vistaAuto.bloques.find((x): x is Extract<BloqueResuelto, { tipo: "parrafo" }> => x.tipo === "parrafo" && x.id === `${b.id}:intro`) ?? null : null;
  const nExtra = b.filasExtra.length;
  const filasErp = tabla ? Math.max(0, tabla.filas.length - nExtra) : 0;

  const cambiarTipo = (auto: TipoAuto) => {
    if (auto === b.auto) return;
    if (nExtra && !window.confirm(`Cambiar a «${INFO_AUTO[auto].nombre}» quita las ${nExtra} ${nExtra === 1 ? "fila escrita" : "filas escritas"} a mano: sus columnas son las de la otra tabla. ¿Seguir?`)) return;
    cambiar((x) => (x.tipo === "auto" ? { ...x, auto, filasExtra: [], conContacto: auto === "cuadro_experiencia" ? x.conContacto : false } : x));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Campo etiqueta="Qué tabla arma">
          <select value={b.auto} disabled={soloLectura} onChange={(e) => cambiarTipo(e.target.value as TipoAuto)} className={`${claseInput} h-9`}>
            {TIPOS_AUTO.map((a) => <option key={a} value={a}>{INFO_AUTO[a].nombre}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Título (opcional)" ayuda={b.titulo ? null : tabla?.titulo ? `Sin escribir sale «${tabla.titulo}».` : "Sin escribir no lleva título."}>
          <input value={b.titulo ?? ""} readOnly={soloLectura} maxLength={LIM.tituloTabla} placeholder={tabla?.titulo ?? "Sin título"}
            onChange={(e) => cambiar((x) => (x.tipo === "auto" ? { ...x, titulo: e.target.value.trim() ? e.target.value : null } : x))} className={claseInput} />
        </Campo>
      </div>
      <div className="rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2 text-xs text-sky-900">
        <p><span className="font-semibold">{info.descripcion}</span></p>
        <p className="mt-0.5">Se arma solo con lo que elegiste en Recursos, Bases o Expediente: aquí no se escribe. {info.deDonde}</p>
        <button type="button" onClick={() => irA(info.paso, info.ancla)} className="mt-1 font-semibold text-[#0b315f] underline">{info.irEtiqueta} →</button>
      </div>
      {b.auto === "cuadro_experiencia" ? (
        <Interruptor marcado={b.conContacto} disabled={soloLectura} cambiar={(conContacto) => cambiar((x) => (x.tipo === "auto" ? { ...x, conContacto } : x))}
          ayuda="Agrega la columna de contacto (nombre y teléfono del cliente)">
          Incluir el contacto de cada cliente
        </Interruptor>
      ) : null}

      <div>
        <p className="mb-1 text-xs font-semibold text-gray-600">Vista previa con los datos de hoy</p>
        {!vistaAuto || vistaAuto.estado === "cargando" ? (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">Comprobando los datos de los que sale la tabla…</p>
        ) : vistaAuto.estado === "error" ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">No se pudo armar la vista previa: {vistaAuto.detalle}</p>
        ) : vistaAuto.estado === "inactiva" ? (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">La sección está desactivada: la tabla no se arma ni se imprime.</p>
        ) : !tabla ? (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">Armando la vista previa…</p>
        ) : (
          <TablaVista tabla={tabla} intro={intro?.texto ?? null} valores={valores} extra={nExtra} />
        )}
        {tabla && !filasErp && !nExtra ? <p className="mt-1 text-xs text-gray-500">Hoy saldría sin filas: completa lo que falta en {info.paso === "bases" ? "Bases" : info.paso === "expediente" ? "Expediente" : "Recursos"}.</p> : null}
      </div>

      <div className="rounded-lg border border-gray-200">
        <button type="button" onClick={() => setExtraAbierto((x) => !x)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-gray-600" aria-expanded={extraAbierto}>
          <span>Filas escritas a mano al final ({nExtra})</span><span>{extraAbierto ? "▴" : "▾"}</span>
        </button>
        {extraAbierto ? (
          <div className="border-t border-gray-100 p-2">
            {tabla ? (
              <EditorTabla encabezadosFijos conAnchos={false} soloLectura={soloLectura} aviso={aviso}
                tabla={{ columnas: tabla.columnas, filas: b.filasExtra, anchos: null }}
                cambiar={(t) => cambiar((x) => (x.tipo === "auto" ? { ...x, filasExtra: t.filas } : x))} />
            ) : (
              <p className="text-xs text-gray-500">{vistaAuto?.estado === "inactiva" ? "Activa la sección para escribir filas: las columnas las pone la tabla automática." : "Las columnas las pone la tabla automática: espera a la vista previa para escribir filas."}</p>
            )}
            <p className="mt-1 text-[11px] text-gray-500">Para un dato que el ERP no tiene (p. ej. una unidad de otro proveedor). Van después de las filas que arma el ERP.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Una tabla resuelta en pequeño (las primeras filas). */
export function TablaVista({ tabla, intro, valores, extra = 0 }: { tabla: Extract<BloqueResuelto, { tipo: "tabla" }>; intro: string | null; valores: ValoresVariables | null; extra?: number }) {
  const filas = tabla.filas.slice(0, MAX_FILAS_VISTA);
  const desdeExtra = tabla.filas.length - extra;
  return (
    <div className="min-w-0">
      {intro ? <p className="mb-1 text-xs text-gray-700"><TextoVista texto={intro} valores={valores} /></p> : null}
      {tabla.titulo ? <p className="mb-1 text-xs font-semibold text-gray-700"><TextoVista texto={tabla.titulo} valores={valores} /></p> : null}
      <div className="max-w-full overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="bg-[#0b315f] text-white">
              {tabla.columnas.map((c, i) => <th key={i} className="px-2 py-1 text-left font-semibold">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {filas.map((f, r) => (
              <tr key={r} className={`border-t border-gray-100 ${r >= desdeExtra ? "bg-amber-50/60" : r % 2 ? "bg-gray-50" : ""}`} title={r >= desdeExtra ? "Fila escrita a mano" : undefined}>
                {f.map((c, j) => <td key={j} className="px-2 py-1 align-top text-gray-700"><TextoVista texto={c} valores={valores} /></td>)}
              </tr>
            ))}
            {!tabla.filas.length ? <tr><td colSpan={tabla.columnas.length || 1} className="px-2 py-2 text-center text-gray-400">Sin filas</td></tr> : null}
            {tabla.pie ? (
              <tr className="border-t border-gray-300 bg-gray-100 font-semibold">
                {tabla.pie.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {tabla.filas.length > MAX_FILAS_VISTA ? <p className="mt-1 text-[11px] text-gray-500">y {tabla.filas.length - MAX_FILAS_VISTA} filas más.</p> : null}
    </div>
  );
}
