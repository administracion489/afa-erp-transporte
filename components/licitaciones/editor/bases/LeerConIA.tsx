"use client";
// components/licitaciones/editor/bases/LeerConIA.tsx — Elegir qué leer (hasta 5 PDF de las bases y/o el
// texto que mandó el cliente) y lanzar la lectura. La lectura en sí vive en el editor (analisis-ia.tsx):
// guarda primero, estima, pide confirmación nombrando el costo y recién entonces lee.
import { useEffect, useMemo, useState } from "react";
import { TOPES_ANALISIS } from "@/lib/licitaciones/analisis";
import type { ArchivoBase, DocLicitacion, TipoBase } from "@/lib/licitaciones/tipos";
import type { TiendaIA } from "../analisis-ia";
import { ETIQUETA_TIPO_BASE, instanteLima } from "../etiquetas";
import { BOTON_PRIMARIO, INPUT, Tarjeta } from "./ui";

const PRIORIDAD: Record<TipoBase, number> = { bases: 0, tdr: 1, absolucion: 2, requisitos_cliente: 3, anexo: 4, otro: 5 };
const esPdf = (b: ArchivoBase) => b.mime === "application/pdf";

const PISTA: Partial<Record<string, string>> = {
  pdf_protegido: "Quita la contraseña del PDF (por ejemplo, imprimiéndolo como PDF) y vuelve a subirlo.",
  en_curso: "Puede ser otra pestaña tuya o de otra persona con esta misma licitación abierta.",
  archivo_ajeno: "Recarga la página y vuelve a elegir los archivos.",
  demasiado_grande: "Elige menos archivos, o sube solo las secciones con los requisitos.",
  demasiadas_paginas: "Elige menos archivos, o sube solo las secciones con los requisitos.",
  demasiados_tokens: "Elige menos archivos, o sube solo las secciones con los requisitos.",
  respuesta_cortada: "Las bases eran demasiado largas para una sola lectura: lee por partes (unas secciones primero y otras después).",
};

type Props = { doc: DocLicitacion; tienda: TiendaIA; soloLectura: boolean; bloqueado: string | null; pendiente: boolean };

export default function LeerConIA({ doc, tienda, soloLectura, bloqueado, pendiente }: Props) {
  const pdfs = useMemo(() => doc.bases.filter(esPdf), [doc.bases]);
  const [sel, setSel] = useState<string[] | null>(null);       // null = la elección por defecto
  const [texto, setTexto] = useState("");
  const [ahora, setAhora] = useState(0);

  const porDefecto = useMemo(
    () => [...pdfs].sort((a, b) => PRIORIDAD[a.tipo] - PRIORIDAD[b.tipo]).slice(0, TOPES_ANALISIS.maxArchivos).map((b) => b.id),
    [pdfs],
  );
  const elegidos = (sel ?? porDefecto).filter((id) => pdfs.some((b) => b.id === id));
  // El orden en que se envían es el de la lista (A1 = el primero de la lista que esté marcado).
  const enviados = pdfs.filter((b) => elegidos.includes(b.id)).map((b) => b.id);

  const err = tienda.error;
  const trabajando = tienda.fase !== "inactivo";
  const relojActivo = tienda.fase === "analizando" || !!err?.reintentarHasta;
  useEffect(() => {
    if (!relojActivo) return;
    const t0 = setTimeout(() => setAhora(Date.now()), 0);
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [relojActivo]);
  const enEspera = !!err?.reintentarHasta && ahora > 0 && err.reintentarHasta > ahora;

  const largoTexto = Array.from(texto).length;
  const motivo =
    soloLectura ? "La licitación está en solo lectura."
      : bloqueado ? bloqueado
      : enEspera ? `podrás volver a intentarlo desde las ${instanteLima(err?.reintentarHasta ?? null).slice(-5)}.`
      : !enviados.length && !texto.trim() ? (pdfs.length ? "Marca al menos un PDF o pega el texto de los requisitos." : "Sube las bases en PDF o pega el texto de los requisitos.")
      : enviados.length > TOPES_ANALISIS.maxArchivos ? `La IA lee como máximo ${TOPES_ANALISIS.maxArchivos} archivos a la vez: desmarca alguno.`
      : largoTexto > TOPES_ANALISIS.maxTexto ? `El texto pasa de ${TOPES_ANALISIS.maxTexto.toLocaleString("es-PE")} caracteres: pega solo la parte de los requisitos.`
      : null;

  const alternar = (id: string) => {
    const base = sel ?? porDefecto;
    setSel(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  const seg = tienda.inicio && ahora > tienda.inicio ? Math.floor((ahora - tienda.inicio) / 1000) : 0;
  const reloj = `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}`;

  return (
    <Tarjeta id="leer_ia" titulo="🤖 Leer las bases con IA"
      subtitulo="La IA lee los PDF elegidos y PROPONE los datos del concurso, los requisitos (con su numeral y su página), las consultas absueltas y la estructura de presentación. Nada entra solo: lo revisas y aceptas punto por punto.">
      <div className="space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">PDF a leer ({enviados.length} de {TOPES_ANALISIS.maxArchivos} como máximo)</p>
        {pdfs.length === 0 ? (
          <p className="text-xs text-gray-500">No hay PDF en las bases subidas. Súbelos arriba (Word o Excel no se leen: guárdalos como PDF).</p>
        ) : (
          <ul className="space-y-1">
            {pdfs.map((b) => {
              const i = enviados.indexOf(b.id);
              return (
                <li key={b.id}>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="mt-1" checked={elegidos.includes(b.id)} disabled={trabajando || soloLectura} onChange={() => alternar(b.id)} />
                    <span className="min-w-0">
                      {i >= 0 && <span className="text-[10px] font-bold text-white bg-[#0b315f] rounded px-1 mr-1">A{i + 1}</span>}
                      <span className="break-all">{b.nombre}</span>
                      <span className="text-[11px] text-gray-500"> · {ETIQUETA_TIPO_BASE[b.tipo]} · {b.paginas != null ? `${b.paginas} pág.` : <span className="text-amber-700">páginas sin contar (¿protegido?)</span>}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <label className="block">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">Texto pegado (opcional)</span>
        <textarea className={`${INPUT} min-h-[80px] text-xs`} value={texto} disabled={trabajando || soloLectura}
          placeholder="Requisitos que el cliente mandó por correo, o una aclaración. Se lee junto con los PDF."
          onChange={(e) => setTexto(e.target.value)} />
        <span className={`block text-[11px] mt-0.5 ${largoTexto > TOPES_ANALISIS.maxTexto ? "text-red-700" : "text-gray-400"}`}>
          {largoTexto.toLocaleString("es-PE")} / {TOPES_ANALISIS.maxTexto.toLocaleString("es-PE")} caracteres
        </span>
      </label>

      <div className="space-y-1.5">
        <button type="button" className={BOTON_PRIMARIO} disabled={trabajando || !!motivo}
          onClick={() => void tienda.leer(enviados, texto.trim() ? texto : null)}>
          {tienda.fase === "guardando" ? "Guardando antes de leer…" : tienda.fase === "estimando" ? "Calculando el costo…" : tienda.fase === "analizando" ? "Leyendo…" : "🤖 Leer las bases con IA"}
        </button>
        {!trabajando && motivo && <p className="text-xs text-gray-500">No se puede leer todavía: {motivo}</p>}
        {!trabajando && !motivo && pendiente && <p className="text-xs text-gray-500">Hay cambios sin guardar: se guardan antes de leer (la IA lee lo guardado).</p>}
        {!trabajando && !motivo && <p className="text-[11px] text-gray-400">Antes de leer se calcula el costo máximo y se te pregunta. Hay un tope de {TOPES_ANALISIS.porDia} lecturas al día para toda la empresa.</p>}
      </div>

      {tienda.fase === "analizando" && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" role="status">
          <p className="font-bold">La IA está leyendo las bases… {reloj}</p>
          <p className="text-xs mt-0.5">Suele tardar de 1 a 3 minutos. Puedes cambiar de paso mientras tanto, pero <b>no cierres ni recargues esta pestaña</b>: la lectura se cobra igual y el resultado solo llega aquí.</p>
        </div>
      )}
      {tienda.fase === "estimando" && <p className="text-xs text-gray-500" role="status">Calculando las páginas y el costo máximo (esto no se cobra)…</p>}
      {tienda.fase === "guardando" && <p className="text-xs text-gray-500" role="status">Guardando la licitación: la IA lee las bases desde lo guardado…</p>}

      {err && !trabajando && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p>{err.texto}</p>
          {PISTA[err.codigo] && <p className="text-xs mt-1">{PISTA[err.codigo]}</p>}
          {enEspera && <p className="text-xs mt-1">El botón se habilita de nuevo cuando pase el plazo.</p>}
          <button type="button" className="mt-1.5 text-[11px] font-bold underline" onClick={tienda.limpiarError}>Entendido</button>
        </div>
      )}

      {tienda.estimacion && !trabajando && !err && !tienda.resultado && (
        <p className="text-[11px] text-gray-400">Última estimación: {tienda.estimacion.paginas} páginas, {tienda.estimacion.tokensEntrada.toLocaleString("es-PE")} tokens de entrada (no se leyó).</p>
      )}
    </Tarjeta>
  );
}
