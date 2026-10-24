"use client";
// components/licitaciones/editor/contenido/EditorTabla.tsx — Editor de grilla de una tabla de la propuesta
// (y de las filas extra de una tabla automática). Columnas y filas se agregan, quitan y mueven dentro de
// TOPES_DOC; se pega desde Excel/Sheets/Word (celdas con tabulaciones y saltos de línea) en la celda donde
// está el cursor o con «Pegar desde Excel»; y los anchos son opcionales, en proporción.
//
// Lo que no cupo al pegar se DICE y queda escrito debajo de la tabla, no en un aviso que se va.

import { useState } from "react";
import { TOPES_DOC } from "@/lib/licitaciones/tipos";
import { Boton, BotonIcono, Interruptor, TopeAlcanzado, claseInput } from "./comun";
import { LIM, esPegadoDeVariasCeldas, fraseSinCupo, parsearTabulado, pegarEnTabla, type TablaEditable } from "./bloques";

type Props = {
  tabla: TablaEditable;
  cambiar: (t: TablaEditable) => void;
  soloLectura: boolean;
  aviso: (texto: string, tono?: "ok" | "error" | "aviso") => void;
  /** Filas extra de una tabla automática: las columnas las pone el ERP (no se editan, agregan ni quitan). */
  encabezadosFijos?: boolean;
  /** Ofrecer los anchos de columna (no en las filas extra: los anchos los pone la tabla automática). */
  conAnchos?: boolean;
};

const MAX = { columnas: TOPES_DOC.maxColumnas, filas: TOPES_DOC.maxFilasTabla, texto: TOPES_DOC.maxTextoBloque };

/** Rellena (o recorta) cada fila a `n` celdas. */
const aAncho = (filas: string[][], n: number) => filas.map((f) => { const r = f.slice(0, n); while (r.length < n) r.push(""); return r; });

export default function EditorTabla({ tabla, cambiar, soloLectura, aviso, encabezadosFijos = false, conAnchos = true }: Props) {
  const ncol = Math.max(1, tabla.columnas.length);
  const filas = aAncho(tabla.filas, ncol);
  const [pegando, setPegando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const fijar = (t: TablaEditable, msg: string | null = null) => { cambiar(t); setMensaje(msg); };
  const conFilas = (f: string[][]) => fijar({ ...tabla, filas: f });

  const celda = (r: number, c: number, v: string) => conFilas(filas.map((f, i) => (i === r ? f.map((x, j) => (j === c ? v.slice(0, MAX.texto) : x)) : f)));
  const encabezado = (c: number, v: string) => fijar({ ...tabla, columnas: tabla.columnas.map((x, j) => (j === c ? v.slice(0, LIM.encabezado) : x)) });

  const filaVacia = () => Array.from({ length: ncol }, () => "");
  const agregarFila = (despues: number) => {
    if (filas.length >= MAX.filas) return;
    const f = [...filas];
    f.splice(despues + 1, 0, filaVacia());
    conFilas(f);
  };
  const quitarFila = (r: number) => {
    const conTexto = filas[r].some((x) => x.trim());
    if (conTexto && !window.confirm(`¿Quitar la fila ${r + 1} («${filas[r].find((x) => x.trim())?.slice(0, 50)}…»)?`)) return;
    conFilas(filas.filter((_, i) => i !== r));
  };
  const moverFila = (r: number, d: -1 | 1) => {
    const a = r + d;
    if (a < 0 || a >= filas.length) return;
    const f = [...filas];
    [f[r], f[a]] = [f[a], f[r]];
    conFilas(f);
  };

  const agregarColumna = () => {
    if (ncol >= MAX.columnas) return;
    const anchos = tabla.anchos ? [...tabla.anchos, Math.max(1, Math.round(tabla.anchos.reduce((a, b) => a + b, 0) / tabla.anchos.length))] : null;
    fijar({ columnas: [...tabla.columnas, ""], filas: filas.map((f) => [...f, ""]), anchos });
  };
  const quitarColumna = (c: number) => {
    if (ncol <= 1) return;
    const escritas = filas.filter((f) => f[c]?.trim()).length;
    const nombre = tabla.columnas[c]?.trim() ? `«${tabla.columnas[c].trim()}»` : `${c + 1}`;
    if (escritas && !window.confirm(`¿Quitar la columna ${nombre} y sus ${escritas} ${escritas === 1 ? "celda escrita" : "celdas escritas"}?`)) return;
    fijar({
      columnas: tabla.columnas.filter((_, j) => j !== c),
      filas: filas.map((f) => f.filter((_, j) => j !== c)),
      anchos: tabla.anchos ? tabla.anchos.filter((_, j) => j !== c) : null,
    });
  };
  const moverColumna = (c: number, d: -1 | 1) => {
    const a = c + d;
    if (a < 0 || a >= ncol) return;
    const sw = <T,>(xs: T[]) => { const o = [...xs]; [o[c], o[a]] = [o[a], o[c]]; return o; };
    fijar({ columnas: sw(tabla.columnas), filas: filas.map(sw), anchos: tabla.anchos ? sw(tabla.anchos) : null });
  };

  /** Pegado en una celda (fila -1 = encabezados): si trae varias celdas, se reparte por la grilla. */
  const alPegar = (e: React.ClipboardEvent, r: number, c: number) => {
    if (soloLectura) return;
    const t = e.clipboardData.getData("text/plain");
    if (!esPegadoDeVariasCeldas(t)) return;
    e.preventDefault();
    const datos = parsearTabulado(t);
    if (!datos.length) return;
    const fila = encabezadosFijos && r < 0 ? 0 : r;
    const base: TablaEditable = { columnas: tabla.columnas.length ? tabla.columnas : [""], filas, anchos: tabla.anchos };
    const limCols = encabezadosFijos ? ncol : MAX.columnas;
    const res = pegarEnTabla(base, fila, c, datos, { ...MAX, columnas: limCols });
    const frase = fraseSinCupo(res.sinCupo, { columnas: limCols, filas: MAX.filas });
    fijar(res.tabla, frase);
    aviso(frase ?? `Se pegaron ${datos.length} ${datos.length === 1 ? "fila" : "filas"}.`, frase ? "aviso" : "ok");
  };

  const anchos = tabla.anchos;
  const sumaAnchos = anchos ? anchos.reduce((a, b) => a + b, 0) : 0;
  const alternarAnchos = (v: boolean) => fijar({ ...tabla, anchos: v ? Array.from({ length: ncol }, () => Math.max(1, Math.round(100 / ncol))) : null });
  const fijarAncho = (c: number, n: number) => { if (anchos) fijar({ ...tabla, anchos: anchos.map((x, j) => (j === c ? n : x)) }); };

  return (
    <div className="min-w-0">
      <div className="max-w-full overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-[#0b315f]/5">
              <th className="w-8 px-1 text-[11px] font-normal text-gray-400">#</th>
              {Array.from({ length: ncol }, (_, c) => (
                <th key={c} className="min-w-[9rem] border-l border-gray-200 p-1 align-top font-normal">
                  {encabezadosFijos ? (
                    <div className="px-1.5 py-1 text-left text-xs font-semibold text-gray-700">{tabla.columnas[c] || `Columna ${c + 1}`}</div>
                  ) : (
                    <>
                      <input value={tabla.columnas[c] ?? ""} onChange={(e) => encabezado(c, e.target.value)} onPaste={(e) => alPegar(e, -1, c)}
                        readOnly={soloLectura} maxLength={LIM.encabezado} placeholder={`Encabezado ${c + 1}`} aria-label={`Encabezado de la columna ${c + 1}`}
                        className={`${claseInput} font-semibold`} />
                      {!soloLectura ? (
                        <div className="mt-0.5 flex justify-center">
                          <BotonIcono title="Mover la columna a la izquierda" disabled={c === 0} onClick={() => moverColumna(c, -1)}>←</BotonIcono>
                          <BotonIcono title="Mover la columna a la derecha" disabled={c === ncol - 1} onClick={() => moverColumna(c, 1)}>→</BotonIcono>
                          <BotonIcono title="Quitar la columna" peligro disabled={ncol <= 1} onClick={() => quitarColumna(c)}>✕</BotonIcono>
                        </div>
                      ) : null}
                      {conAnchos && anchos ? (
                        <div className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-gray-500">
                          <NumeroAncho valor={anchos[c] ?? 1} cambiar={(n) => fijarAncho(c, n)} soloLectura={soloLectura} etiqueta={`Ancho de la columna ${c + 1}`} />
                          <span>{sumaAnchos ? `${Math.round(((anchos[c] ?? 0) / sumaAnchos) * 100)} %` : ""}</span>
                        </div>
                      ) : null}
                    </>
                  )}
                </th>
              ))}
              {!soloLectura ? <th className="w-24" /> : null}
            </tr>
          </thead>
          <tbody>
            {filas.map((f, r) => (
              <tr key={r} className="border-t border-gray-200 even:bg-gray-50/50">
                <td className="px-1 text-center text-[11px] text-gray-400">{r + 1}</td>
                {f.map((v, c) => (
                  <td key={c} className="border-l border-gray-200 p-1 align-top">
                    <textarea value={v} rows={1} onChange={(e) => celda(r, c, e.target.value)} onPaste={(e) => alPegar(e, r, c)}
                      readOnly={soloLectura} maxLength={MAX.texto} aria-label={`Fila ${r + 1}, columna ${c + 1}`}
                      className={`${claseInput} resize-none [field-sizing:content] min-h-8 max-h-48`} />
                  </td>
                ))}
                {!soloLectura ? (
                  <td className="whitespace-nowrap px-1 align-top">
                    <BotonIcono title="Subir la fila" disabled={r === 0} onClick={() => moverFila(r, -1)}>↑</BotonIcono>
                    <BotonIcono title="Bajar la fila" disabled={r === filas.length - 1} onClick={() => moverFila(r, 1)}>↓</BotonIcono>
                    <BotonIcono title="Quitar la fila" peligro onClick={() => quitarFila(r)}>✕</BotonIcono>
                  </td>
                ) : null}
              </tr>
            ))}
            {!filas.length ? (
              <tr><td colSpan={ncol + 2} className="px-3 py-3 text-center text-xs text-gray-500">{encabezadosFijos ? "Sin filas escritas a mano." : "La tabla no tiene filas."}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!soloLectura ? (
          <>
            <Boton tam="sm" onClick={() => agregarFila(filas.length - 1)} disabled={filas.length >= MAX.filas}>+ Fila</Boton>
            {!encabezadosFijos ? <Boton tam="sm" onClick={agregarColumna} disabled={ncol >= MAX.columnas}>+ Columna</Boton> : null}
            <Boton tam="sm" tono="suave" onClick={() => setPegando((x) => !x)}>📋 Pegar desde Excel</Boton>
            {conAnchos && !encabezadosFijos ? <Interruptor marcado={!!anchos} cambiar={alternarAnchos}>Fijar el ancho de cada columna</Interruptor> : null}
          </>
        ) : null}
        <span className="ml-auto text-[11px] text-gray-500">{filas.length}/{MAX.filas} filas · {ncol}/{encabezadosFijos ? ncol : MAX.columnas} columnas</span>
      </div>
      {!soloLectura && filas.length >= MAX.filas ? <TopeAlcanzado>La tabla llegó al tope de {MAX.filas} filas: divídela en dos tablas.</TopeAlcanzado> : null}
      {!soloLectura && !encabezadosFijos && ncol >= MAX.columnas ? <TopeAlcanzado>La tabla llegó al tope de {MAX.columnas} columnas.</TopeAlcanzado> : null}
      {conAnchos && anchos ? <p className="mt-1 text-[11px] text-gray-500">Los anchos se reparten en proporción al ancho de la hoja (suman {sumaAnchos}; no hace falta que sumen 100).</p> : null}
      {mensaje ? <p className="mt-1 text-xs text-amber-700">{mensaje}</p> : null}
      {!soloLectura && !pegando ? <p className="mt-1 text-[11px] text-gray-500">Consejo: copia celdas en Excel y pégalas en una celda; se reparten desde ahí.</p> : null}
      {pegando && !soloLectura ? (
        <PegarTabla
          encabezadosFijos={encabezadosFijos}
          hayContenido={filas.some((f) => f.some((x) => x.trim())) || tabla.columnas.some((x) => x.trim())}
          cerrar={() => setPegando(false)}
          aplicar={(pegados, conEncabezado, modo) => {
            const limCols = encabezadosFijos ? ncol : MAX.columnas;
            let base: TablaEditable;
            let fila: number;
            let datos = pegados;
            if (modo === "reemplazar" && !encabezadosFijos) {
              base = { columnas: [""], filas: [], anchos: null };
              fila = conEncabezado ? -1 : 0;
            } else {
              base = modo === "reemplazar"
                ? { columnas: tabla.columnas, filas: [], anchos: tabla.anchos }
                : { columnas: tabla.columnas.length ? tabla.columnas : [""], filas, anchos: tabla.anchos };
              fila = modo === "reemplazar" ? 0 : filas.length;
              if (conEncabezado) datos = datos.slice(1);
            }
            const res = pegarEnTabla(base, fila, 0, datos, { ...MAX, columnas: limCols });
            const frase = fraseSinCupo(res.sinCupo, { columnas: limCols, filas: MAX.filas });
            fijar(res.tabla, frase);
            setPegando(false);
            aviso(frase ?? "Tabla pegada.", frase ? "aviso" : "ok");
          }}
        />
      ) : null}
    </div>
  );
}

/** Un ancho de columna: guarda un borrador mientras se escribe y solo cambia la tabla con un número válido. */
function NumeroAncho({ valor, cambiar, soloLectura, etiqueta }: { valor: number; cambiar: (n: number) => void; soloLectura: boolean; etiqueta: string }) {
  const [borrador, setBorrador] = useState<string | null>(null);
  return (
    <input type="text" inputMode="numeric" aria-label={etiqueta} readOnly={soloLectura}
      value={borrador ?? String(valor)}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
        setBorrador(t);
        const n = Number(t);
        if (t && n >= 1 && n <= 100) cambiar(n);
      }}
      onBlur={() => setBorrador(null)}
      className="h-6 w-10 rounded border border-gray-300 px-1 text-center text-[11px]" />
  );
}

/** Panel para pegar una tabla entera (con o sin fila de encabezados). */
function PegarTabla({ aplicar, cerrar, encabezadosFijos, hayContenido }: {
  aplicar: (datos: string[][], conEncabezado: boolean, modo: "reemplazar" | "agregar") => void;
  cerrar: () => void; encabezadosFijos: boolean; hayContenido: boolean;
}) {
  const [texto, setTexto] = useState("");
  const [conEncabezado, setConEncabezado] = useState(!encabezadosFijos);
  const datos = texto.trim() ? parsearTabulado(texto) : [];
  const cols = Math.max(0, ...datos.map((d) => d.length));
  const n = datos.length - (conEncabezado ? 1 : 0);
  return (
    <div className="mt-2 rounded-xl border border-[#0b315f]/20 bg-[#0b315f]/[0.03] p-3">
      <p className="text-xs text-gray-600">Copia las celdas en Excel, Google Sheets o una tabla de Word y pégalas aquí.</p>
      <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={5} placeholder="Pega aquí (Ctrl+V)…" className={`${claseInput} mt-2 font-mono text-xs`} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Interruptor marcado={conEncabezado} cambiar={setConEncabezado}>
          {encabezadosFijos ? "La primera fila pegada son encabezados (no se copia)" : "La primera fila son los encabezados"}
        </Interruptor>
        <span className="text-xs text-gray-500">{datos.length ? `${Math.max(0, n)} ${n === 1 ? "fila" : "filas"} × ${cols} ${cols === 1 ? "columna" : "columnas"}` : "Nada pegado todavía"}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Boton tam="sm" tono="primario" disabled={!datos.length}
          onClick={() => { if (hayContenido && !window.confirm(`Se reemplazará la tabla actual por las ${Math.max(0, n)} filas pegadas. ¿Seguir?`)) return; aplicar(datos, conEncabezado, "reemplazar"); }}>
          Reemplazar la tabla
        </Boton>
        <Boton tam="sm" disabled={!datos.length} onClick={() => aplicar(datos, conEncabezado, "agregar")}>Agregar al final</Boton>
        <Boton tam="sm" tono="suave" onClick={cerrar}>Cancelar</Boton>
      </div>
    </div>
  );
}
