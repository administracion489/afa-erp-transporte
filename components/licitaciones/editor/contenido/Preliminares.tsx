"use client";
// components/licitaciones/editor/contenido/Preliminares.tsx — Lo que va antes y después de las secciones:
// portada, control del documento, carta de presentación, glosario, índice y cierre.
//
// Cada campo que queda vacío tiene un valor por defecto que pone resolverDocumento (la fecha, el
// destinatario, la referencia…): el placeholder lo ENSEÑA, para que «vacío» no se lea como «no saldrá
// nada». Lo que sale solo del concurso o del perfil (cliente, postor) no se ofrece como campo.

import { useState } from "react";
import { cabeceraDe } from "@/lib/licitaciones/tablas";
import { fechaRef, representanteDe, resolverVariables, type ValoresVariables } from "@/lib/licitaciones/texto";
import type { ArchivoRef, ContextoLicitacion, DocLicitacion, EntradaGlosario, Licitacion, Paso } from "@/lib/licitaciones/tipos";
import { fechaLarga } from "@/lib/licitaciones/util";
import { Boton, BotonIcono, Campo, CampoTexto, Interruptor, MiniaturaDoc, Tarjeta, TopeAlcanzado, claseInput } from "./comun";
import { LIM, mover, parsearTabulado } from "./bloques";

export type PanelPreliminar = "portada" | "control" | "carta" | "glosario" | "indice" | "cierre";
export const PANELES_INICIO: readonly PanelPreliminar[] = ["portada", "control", "carta", "glosario", "indice"];
export const NOMBRE_PANEL: Record<PanelPreliminar, string> = {
  portada: "Portada", control: "Control del documento", carta: "Carta de presentación", glosario: "Glosario", indice: "Índice", cierre: "Cierre y firma",
};

type Aviso = (texto: string, tono?: "ok" | "error" | "aviso") => void;
export type PropsPreliminar = {
  lic: Licitacion;
  doc: DocLicitacion;
  ctx: ContextoLicitacion | null;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  soloLectura: boolean;
  valores: ValoresVariables | null;
  aviso: Aviso;
  subirImagen: (file: File) => Promise<ArchivoRef>;
  irA: (paso: Paso, ancla?: string | null) => void;
  nuevoId: () => string;
  resaltado: boolean;
  domId: string;
};

/** ¿El panel está encendido (sale en el PDF)? La portada siempre. */
export function panelActivo(doc: DocLicitacion, p: PanelPreliminar): boolean {
  switch (p) {
    case "portada": return true;
    case "control": return doc.control.activo;
    case "carta": return doc.carta.activa;
    case "glosario": return doc.glosario.activo;
    case "indice": return doc.indice.activo;
    case "cierre": return doc.cierre.activo;
  }
}

export default function PanelPreliminarEditor(p: PropsPreliminar & { panel: PanelPreliminar }) {
  switch (p.panel) {
    case "portada": return <PanelPortada {...p} />;
    case "control": return <PanelControl {...p} />;
    case "carta": return <PanelCarta {...p} />;
    case "glosario": return <PanelGlosario {...p} />;
    case "indice": return <PanelIndice {...p} />;
    case "cierre": return <PanelCierre {...p} />;
  }
}

// ══ Portada ═════════════════════════════════════════════════════════════════════

const RE_COLOR = /^#[0-9a-fA-F]{6}$/;

function PanelPortada(p: PropsPreliminar) {
  const { doc, cambiarDoc, soloLectura, valores, aviso, lic, ctx } = p;
  const po = doc.portada;
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colorBorrador, setColorBorrador] = useState<string | null>(null);
  const cambiar = (patch: Partial<DocLicitacion["portada"]>) => cambiarDoc((d) => ({ ...d, portada: { ...d.portada, ...patch } }));
  const cabeceraDefecto = ctx ? cabeceraDe({ ...lic, doc: { ...doc, portada: { ...po, cabecera: "" } } }, ctx) : null;
  const res = (t: string) => (valores ? resolverVariables(t, valores).texto : t);

  const subir = async (file: File | undefined) => {
    if (!file) return;
    setSubiendo(true); setError(null);
    try {
      const ref = await p.subirImagen(file);
      cambiar({ imagen: ref, modo: "imagen" });
      aviso("Imagen de portada subida.", "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo subir la imagen.");
    } finally { setSubiendo(false); }
  };

  return (
    <Tarjeta titulo="Portada" id={p.domId} resaltado={p.resaltado} subtitulo="La primera hoja del PDF. El color se usa también en la cabecera, los títulos y las tablas.">
      <div className="mb-3 flex flex-wrap gap-4">
        {(["generada", "imagen"] as const).map((m) => (
          <label key={m} className="inline-flex min-h-8 items-center gap-2 text-sm text-gray-700">
            <input type="radio" className="accent-[#0b315f]" checked={po.modo === m} disabled={soloLectura} onChange={() => cambiar({ modo: m })} />
            {m === "generada" ? "Generada por el ERP" : "Una imagen que subo (hoja completa)"}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_11rem]">
        <div className="min-w-0 space-y-3">
          {po.modo === "imagen" ? (
            <div className="rounded-xl border border-gray-200 p-3">
              {po.imagen ? (
                <div className="flex flex-wrap items-start gap-3">
                  <MiniaturaDoc url={po.imagen.url} alt="Portada" className="h-40 w-auto rounded border border-gray-200 object-contain" />
                  <div className="min-w-0 space-y-2 text-xs text-gray-600">
                    <p className="break-all font-semibold text-gray-700">{po.imagen.nombre}</p>
                    <p>Cubre la hoja A4 vertical entera; lo que sobre por los bordes queda fuera. Usa una imagen vertical.</p>
                    {!soloLectura ? (
                      <div className="flex flex-wrap gap-1.5">
                        <SubirImagen texto="Cambiar" subiendo={subiendo} subir={subir} />
                        <Boton tam="sm" tono="peligro" onClick={() => { if (window.confirm("¿Quitar la imagen de portada? Se imprimirá la portada generada.")) cambiar({ imagen: null, modo: "generada" }); }}>Quitar</Boton>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <p className="mb-2 text-sm text-amber-800">Sin imagen todavía: mientras tanto se imprime la portada generada.</p>
                  {!soloLectura ? <SubirImagen texto="Subir PNG o JPG" subiendo={subiendo} subir={subir} /> : null}
                </div>
              )}
              {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
            </div>
          ) : null}
          <Campo etiqueta="Título" ayuda={po.modo === "imagen" ? "Con imagen no se dibuja, pero se usa como nombre del documento y en el control." : undefined}>
            <CampoTexto valor={po.titulo} max={LIM.portadaTitulo} valores={valores} soloLectura={soloLectura} aviso={aviso} negrita={false} placeholder="Propuesta Técnica" cambiar={(titulo) => cambiar({ titulo })} />
          </Campo>
          <Campo etiqueta="Subtítulo">
            <CampoTexto valor={po.subtitulo} max={LIM.portadaSubtitulo} valores={valores} soloLectura={soloLectura} aviso={aviso} negrita={false} placeholder="Servicio de transporte de personal…" cambiar={(subtitulo) => cambiar({ subtitulo })} />
          </Campo>
          <Campo etiqueta="Cabecera de cada hoja" ayuda={cabeceraDefecto ? <>Vacía sale: «{cabeceraDefecto}».</> : "Vacía, el ERP arma una con el cliente, el concurso y la empresa."}>
            <CampoTexto valor={po.cabecera} max={LIM.cabecera} valores={valores} soloLectura={soloLectura} aviso={aviso} negrita={false} placeholder={cabeceraDefecto ?? "Propuesta Técnica · cliente · concurso · empresa"} cambiar={(cabecera) => cambiar({ cabecera })} />
          </Campo>
          <Campo etiqueta="Color del documento">
            <div className="flex flex-wrap items-center gap-2">
              <input type="color" value={RE_COLOR.test(po.color) ? po.color : "#0b315f"} disabled={soloLectura} onChange={(e) => { setColorBorrador(null); cambiar({ color: e.target.value.toLowerCase() }); }}
                className="h-9 w-12 cursor-pointer rounded border border-gray-300 bg-white" aria-label="Elegir el color" />
              <input value={colorBorrador ?? po.color} readOnly={soloLectura} maxLength={7} aria-label="Color en #RRGGBB"
                onChange={(e) => { const v = e.target.value.trim(); setColorBorrador(v); if (RE_COLOR.test(v)) cambiar({ color: v.toLowerCase() }); }}
                onBlur={() => setColorBorrador(null)} className={`${claseInput} w-28 font-mono`} />
              {colorBorrador && !RE_COLOR.test(colorBorrador) ? <span className="text-xs text-amber-700">Escribe el color como #RRGGBB (p. ej. #0b315f).</span> : null}
            </div>
          </Campo>
          {po.modo === "generada" ? (
            <p className="text-xs text-gray-500">Además, la portada generada imprime sola, de los datos del concurso y del perfil de la empresa: el cliente, el código del concurso, el objeto, el postor con su RUC y la fecha de presentación.</p>
          ) : null}
        </div>
        {po.modo === "generada" ? (
          <div className="hidden lg:block" aria-hidden>
            <div className="aspect-[210/297] w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
              <div className="h-1/3 p-3" style={{ background: RE_COLOR.test(po.color) ? po.color : "#0b315f" }}>
                <p className="line-clamp-3 text-[11px] font-bold leading-tight text-white">{res(po.titulo) || "Propuesta Técnica"}</p>
                <p className="mt-1 line-clamp-2 text-[9px] leading-tight text-white/80">{res(po.subtitulo)}</p>
              </div>
              <div className="space-y-1 p-3">
                {[lic.cliente_nombre, lic.codigo, lic.objeto].filter((x): x is string => !!x && !!x.trim()).slice(0, 3).map((x, i) => (
                  <p key={i} className="truncate text-[8px] text-gray-500">{x}</p>
                ))}
              </div>
            </div>
            <p className="mt-1 text-center text-[10px] text-gray-400">Boceto, no a escala</p>
          </div>
        ) : null}
      </div>
    </Tarjeta>
  );
}

function SubirImagen({ texto, subiendo, subir }: { texto: string; subiendo: boolean; subir: (f: File | undefined) => void }) {
  return (
    <label className={`inline-flex min-h-8 cursor-pointer items-center justify-center rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${subiendo ? "pointer-events-none opacity-50" : ""}`}>
      {subiendo ? "Subiendo…" : texto}
      <input type="file" accept="image/png,image/jpeg" className="sr-only" disabled={subiendo} onChange={(e) => { subir(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );
}

// ══ Control del documento ═══════════════════════════════════════════════════════

function PanelControl(p: PropsPreliminar) {
  const { doc, cambiarDoc, soloLectura, valores, aviso, lic } = p;
  const c = doc.control;
  const cambiar = (patch: Partial<DocLicitacion["control"]>) => cambiarDoc((d) => ({ ...d, control: { ...d.control, ...patch } }));
  const campo = (k: "documento" | "version" | "codigo" | "elaboradoPor" | "revisadoPor" | "aprobadoPor" | "confidencialidad", etiqueta: string, max: number, placeholder: string, ayuda?: string) => (
    <Campo etiqueta={etiqueta} ayuda={ayuda}>
      <CampoTexto valor={c[k]} max={max} valores={valores} soloLectura={soloLectura || !c.activo} aviso={aviso} negrita={false} placeholder={placeholder} cambiar={(v) => cambiar({ [k]: v })} />
    </Campo>
  );
  return (
    <Tarjeta titulo="Control del documento" id={p.domId} resaltado={p.resaltado} subtitulo="Una hoja con la ficha del documento: versión, quién lo elaboró, revisó y aprobó.">
      <Interruptor marcado={c.activo} disabled={soloLectura} cambiar={(activo) => cambiar({ activo })}>Incluir el control del documento</Interruptor>
      <div className={`mt-3 grid gap-3 sm:grid-cols-2 ${c.activo ? "" : "opacity-60"}`}>
        {campo("documento", "Documento", LIM.controlCampo, `Vacío = el título de la portada («${doc.portada.titulo || "Propuesta Técnica"}»)`)}
        {campo("version", "Versión", LIM.controlVersion, "1.0 — Presentación de propuesta")}
        {campo("codigo", "Código del documento (opcional)", LIM.controlCodigo, "Vacío = no se imprime la fila")}
        <Campo etiqueta="Fecha" ayuda={c.fecha ? undefined : lic.fecha_presentacion ? "Vacía = la fecha de presentación." : "Vacía = la fecha de presentación (todavía sin fecha: sale «—»)."}>
          <input type="date" value={c.fecha ?? ""} readOnly={soloLectura || !c.activo} onChange={(e) => cambiar({ fecha: e.target.value || null })} className={claseInput} />
        </Campo>
        {campo("elaboradoPor", "Elaborado por", LIM.controlCampo, "Área de Operaciones")}
        {campo("revisadoPor", "Revisado por", LIM.controlCampo, "Nombre — cargo")}
        {campo("aprobadoPor", "Aprobado por", LIM.controlCampo, "Nombre — cargo")}
        {campo("confidencialidad", "Confidencialidad", LIM.confidencialidad, "Documento de uso exclusivo para el concurso {concurso}")}
      </div>
      <p className="mt-3 text-xs text-gray-500">Las filas «Cliente» y «Postor» salen solas, de los datos del concurso y del perfil de la empresa. Un campo vacío sale «—».</p>
    </Tarjeta>
  );
}

// ══ Firma (carta y cierre) ══════════════════════════════════════════════════════

function FirmaInfo({ doc, ctx, irA }: { doc: DocLicitacion; ctx: ContextoLicitacion | null; irA: PropsPreliminar["irA"] }) {
  if (!ctx) return <p className="text-xs text-gray-500">Comprobando el representante legal…</p>;
  const r = representanteDe(doc, ctx);
  if (!r.nombre) {
    return (
      <p className="text-xs text-amber-800">
        Falta el representante legal: sin él la firma sale vacía.{" "}
        <button type="button" onClick={() => irA("recursos", "representante")} className="font-semibold underline">Elegirlo en Recursos →</button>
      </p>
    );
  }
  return (
    <p className="text-xs text-gray-600">
      Firma: <span className="font-semibold text-gray-800">{r.nombre}</span>{r.cargo ? ` — ${r.cargo}` : ""}{r.dni ? ` · DNI ${r.dni}` : ""}.{" "}
      {r.firmaUrl ? "Con imagen de firma." : <span className="text-amber-800">Sin imagen de firma (sale la línea para firmar a mano).</span>}{" "}
      <button type="button" onClick={() => irA("recursos", "representante")} className="text-[#0b315f] underline">Cambiar en Recursos</button>
    </p>
  );
}

// ══ Carta de presentación ═══════════════════════════════════════════════════════

function PanelCarta(p: PropsPreliminar) {
  const { doc, cambiarDoc, soloLectura, valores, aviso, lic, ctx } = p;
  const k = doc.carta;
  const ro = soloLectura || !k.activa;
  const cambiar = (patch: Partial<DocLicitacion["carta"]>) => cambiarDoc((d) => ({ ...d, carta: { ...d.carta, ...patch } }));
  const fechaDefecto = ctx ? fechaLarga(fechaRef(lic, ctx)) : null;
  const refDefecto = [lic.codigo ? `Concurso ${lic.codigo}` : null, lic.nombre.trim() || null].filter(Boolean).join(" — ");
  return (
    <Tarjeta titulo="Carta de presentación" id={p.domId} resaltado={p.resaltado} subtitulo="Va después del control del documento, firmada por el representante legal.">
      <Interruptor marcado={k.activa} disabled={soloLectura} cambiar={(activa) => cambiar({ activa })}>Incluir la carta de presentación</Interruptor>
      <div className={`mt-3 space-y-3 ${k.activa ? "" : "opacity-60"}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Campo etiqueta="Lugar y fecha" ayuda={fechaDefecto ? `Vacío = «${fechaDefecto}».` : "Vacío = la fecha de presentación en letras."}>
            <CampoTexto valor={k.lugarFecha} max={LIM.cartaCorto} valores={valores} soloLectura={ro} aviso={aviso} negrita={false} placeholder={fechaDefecto ? `Lima, ${fechaDefecto}` : "Lima, …"} cambiar={(lugarFecha) => cambiar({ lugarFecha })} />
          </Campo>
          <Campo etiqueta="Atención" ayuda={k.atencion ? undefined : lic.atencion ? `Vacío = «${lic.atencion}» (datos del concurso).` : "Vacío = el «A la atención de» de los datos del concurso."}>
            <CampoTexto valor={k.atencion} max={LIM.cartaCorto} valores={valores} soloLectura={ro} aviso={aviso} negrita={false} placeholder={lic.atencion ?? "Sr. … — Ejecutivo de Compras"} cambiar={(atencion) => cambiar({ atencion })} />
          </Campo>
        </div>
        <Campo etiqueta="Destinatario (una línea por renglón)" ayuda={`Vacío = «Señores» y ${lic.cliente_nombre.trim() ? `«${lic.cliente_nombre.trim().toUpperCase()}» en negrita` : "el nombre del cliente"}.`}>
          <CampoTexto multilinea filas={3} valor={k.destinatario} max={LIM.cartaLargo} valores={valores} soloLectura={ro} aviso={aviso} vista={false}
            placeholder={`Señores\n**${(lic.cliente_nombre || "CLIENTE").toUpperCase()}**\nPresente.-`} cambiar={(destinatario) => cambiar({ destinatario })} />
        </Campo>
        <Campo etiqueta="Referencia" ayuda={refDefecto ? `Vacía = «${refDefecto}».` : "Vacía = el código y el nombre de la licitación."}>
          <CampoTexto multilinea filas={2} valor={k.referencia} max={LIM.cartaLargo} valores={valores} soloLectura={ro} aviso={aviso} negrita={false} placeholder={refDefecto || "Concurso … — …"} cambiar={(referencia) => cambiar({ referencia })} />
        </Campo>
        <Campo etiqueta="Cuerpo de la carta" ayuda="Separa los párrafos con una línea en blanco.">
          <CampoTexto multilinea filas={10} valor={k.cuerpo} max={LIM.texto} valores={valores} soloLectura={ro} aviso={aviso}
            placeholder="De nuestra consideración: {razon_social}, con RUC N° {ruc}, representada por…" cambiar={(cuerpo) => cambiar({ cuerpo })} />
        </Campo>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Campo etiqueta="Despedida">
            <input value={k.despedida} readOnly={ro} maxLength={LIM.cartaCorto} placeholder="Atentamente," onChange={(e) => cambiar({ despedida: e.target.value })} className={claseInput} />
          </Campo>
          <div className="flex flex-col justify-end gap-1">
            <Interruptor marcado={k.conFirma} disabled={ro} cambiar={(conFirma) => cambiar({ conFirma })}>Con la firma del representante</Interruptor>
          </div>
        </div>
        {k.conFirma ? <FirmaInfo doc={doc} ctx={ctx} irA={p.irA} /> : null}
      </div>
    </Tarjeta>
  );
}

// ══ Glosario ════════════════════════════════════════════════════════════════════

function PanelGlosario(p: PropsPreliminar) {
  const { doc, cambiarDoc, soloLectura, aviso, valores } = p;
  const g = doc.glosario;
  const [pegando, setPegando] = useState(false);
  const [texto, setTexto] = useState("");
  const lleno = g.entradas.length >= LIM.glosario;
  const conEntradas = (fn: (e: EntradaGlosario[]) => EntradaGlosario[]) => cambiarDoc((d) => ({ ...d, glosario: { ...d.glosario, entradas: fn(d.glosario.entradas) } }));
  const cambiarEntrada = (id: string, patch: Partial<EntradaGlosario>) => conEntradas((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const agregar = () => {
    if (lleno) return;
    const nueva: EntradaGlosario = { id: p.nuevoId(), termino: "", definicion: "" };
    conEntradas((es) => (es.length >= LIM.glosario ? es : [...es, nueva]));
  };
  const quitar = (e: EntradaGlosario) => {
    if ((e.termino.trim() || e.definicion.trim()) && !window.confirm(`¿Quitar «${e.termino.trim() || "el término sin nombre"}» del glosario?`)) return;
    conEntradas((es) => es.filter((x) => x.id !== e.id));
  };
  const ordenar = () => conEntradas((es) => [...es].sort((a, b) => (a.termino.trim() || "￿").localeCompare(b.termino.trim() || "￿", "es", { sensitivity: "base" })));
  const pegados = texto.trim() ? parsearTabulado(texto).filter((f) => (f[0] ?? "").trim() || (f[1] ?? "").trim()) : [];
  const aplicarPegado = () => {
    const libres = LIM.glosario - g.entradas.length;
    const toma = pegados.slice(0, Math.max(0, libres));
    const nuevas: EntradaGlosario[] = toma.map((f) => ({ id: p.nuevoId(), termino: (f[0] ?? "").slice(0, LIM.termino), definicion: (f[1] ?? "").slice(0, LIM.definicion) }));
    conEntradas((es) => [...es, ...nuevas].slice(0, LIM.glosario));
    aviso(toma.length < pegados.length ? `Se agregaron ${toma.length} términos; ${pegados.length - toma.length} no cupieron (el tope es ${LIM.glosario}).` : `Se agregaron ${toma.length} términos.`, toma.length < pegados.length ? "aviso" : "ok");
    setTexto(""); setPegando(false);
  };
  return (
    <Tarjeta titulo="Glosario" id={p.domId} resaltado={p.resaltado} subtitulo="Los términos y siglas del documento, en una tabla Término · Definición."
      acciones={!soloLectura && g.entradas.length > 1 ? <Boton tam="sm" tono="suave" onClick={ordenar}>Ordenar A→Z</Boton> : null}>
      <Interruptor marcado={g.activo} disabled={soloLectura} cambiar={(activo) => cambiarDoc((d) => ({ ...d, glosario: { ...d.glosario, activo } }))}>Incluir el glosario</Interruptor>
      {g.activo && !g.entradas.length ? <p className="mt-2 text-xs text-amber-800">Activo y sin términos: no se imprime hasta que agregues alguno.</p> : null}
      <div className={`mt-3 space-y-2 ${g.activo ? "" : "opacity-60"}`}>
        {g.entradas.map((e, i) => (
          <div key={e.id} className="grid grid-cols-1 gap-2 rounded-xl border border-gray-200 p-2 sm:grid-cols-[12rem_1fr_auto]">
            <input value={e.termino} readOnly={soloLectura} maxLength={LIM.termino} placeholder="Término o sigla" aria-label={`Término ${i + 1}`}
              onChange={(x) => cambiarEntrada(e.id, { termino: x.target.value })} className={`${claseInput} font-semibold`} />
            <CampoTexto multilinea filas={2} valor={e.definicion} max={LIM.definicion} valores={valores} soloLectura={soloLectura} aviso={aviso} marcas={false} vista={false}
              placeholder="Definición" cambiar={(definicion) => cambiarEntrada(e.id, { definicion })} />
            {!soloLectura ? (
              <div className="flex items-start justify-end">
                <BotonIcono title="Subir" disabled={i === 0} onClick={() => conEntradas((es) => mover(es, i, i - 1))}>↑</BotonIcono>
                <BotonIcono title="Bajar" disabled={i === g.entradas.length - 1} onClick={() => conEntradas((es) => mover(es, i, i + 1))}>↓</BotonIcono>
                <BotonIcono title="Quitar el término" peligro onClick={() => quitar(e)}>✕</BotonIcono>
              </div>
            ) : null}
          </div>
        ))}
        {!soloLectura ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Boton tam="sm" onClick={agregar} disabled={lleno}>+ Agregar término</Boton>
            <Boton tam="sm" tono="suave" onClick={() => setPegando((x) => !x)} disabled={lleno}>📋 Pegar desde Excel</Boton>
            <span className="ml-auto text-[11px] text-gray-500">{g.entradas.length}/{LIM.glosario} términos</span>
          </div>
        ) : null}
        {lleno && !soloLectura ? <TopeAlcanzado>El glosario llegó al tope de {LIM.glosario} términos.</TopeAlcanzado> : null}
        {pegando && !soloLectura ? (
          <div className="rounded-xl border border-[#0b315f]/20 bg-[#0b315f]/[0.03] p-3">
            <p className="text-xs text-gray-600">Copia dos columnas de Excel o de una tabla de Word (término y definición) y pégalas aquí. Se agregan al final.</p>
            <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={4} className={`${claseInput} mt-2 font-mono text-xs`} placeholder="Pega aquí (Ctrl+V)…" />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Boton tam="sm" tono="primario" disabled={!pegados.length} onClick={aplicarPegado}>Agregar {pegados.length || ""} {pegados.length === 1 ? "término" : "términos"}</Boton>
              <Boton tam="sm" tono="suave" onClick={() => { setPegando(false); setTexto(""); }}>Cancelar</Boton>
            </div>
          </div>
        ) : null}
      </div>
    </Tarjeta>
  );
}

// ══ Índice ══════════════════════════════════════════════════════════════════════

function PanelIndice(p: PropsPreliminar) {
  const { doc, cambiarDoc, soloLectura } = p;
  const ix = doc.indice;
  return (
    <Tarjeta titulo="Índice" id={p.domId} resaltado={p.resaltado} subtitulo="Lo arma el ERP con las páginas reales al dibujar el PDF: aquí solo se elige si va y cuántos niveles.">
      <Interruptor marcado={ix.activo} disabled={soloLectura} cambiar={(activo) => cambiarDoc((d) => ({ ...d, indice: { ...d.indice, activo } }))}>Incluir el índice</Interruptor>
      <div className={`mt-3 flex flex-wrap gap-4 ${ix.activo ? "" : "opacity-60"}`}>
        {([1, 2] as const).map((n) => (
          <label key={n} className="inline-flex min-h-8 items-center gap-2 text-sm text-gray-700">
            <input type="radio" className="accent-[#0b315f]" checked={ix.niveles === n} disabled={soloLectura || !ix.activo} onChange={() => cambiarDoc((d) => ({ ...d, indice: { ...d.indice, niveles: n } }))} />
            {n === 1 ? "Solo las secciones" : "Secciones y subtítulos de nivel 2"}
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">Solo entran las secciones activas. Un título largo se recorta con «…» para que cada entrada ocupe un renglón.</p>
    </Tarjeta>
  );
}

// ══ Cierre ══════════════════════════════════════════════════════════════════════

function PanelCierre(p: PropsPreliminar) {
  const { doc, cambiarDoc, soloLectura, valores, aviso, ctx } = p;
  const c = doc.cierre;
  const cambiar = (patch: Partial<DocLicitacion["cierre"]>) => cambiarDoc((d) => ({ ...d, cierre: { ...d.cierre, ...patch } }));
  return (
    <Tarjeta titulo="Cierre y firma" id={p.domId} resaltado={p.resaltado} subtitulo="Un párrafo final después de la última sección, con la firma del representante legal.">
      <Interruptor marcado={c.activo} disabled={soloLectura} cambiar={(activo) => cambiar({ activo })}>Incluir el cierre</Interruptor>
      <div className={`mt-3 space-y-3 ${c.activo ? "" : "opacity-60"}`}>
        <CampoTexto multilinea filas={4} valor={c.texto} max={LIM.texto} valores={valores} soloLectura={soloLectura || !c.activo} aviso={aviso}
          placeholder="Sin otro particular, quedamos a su disposición…" cambiar={(texto) => cambiar({ texto })} />
        <Interruptor marcado={c.conFirma} disabled={soloLectura || !c.activo} cambiar={(conFirma) => cambiar({ conFirma })}>Con la firma del representante</Interruptor>
        {c.conFirma ? <FirmaInfo doc={doc} ctx={ctx} irA={p.irA} /> : null}
      </div>
    </Tarjeta>
  );
}
