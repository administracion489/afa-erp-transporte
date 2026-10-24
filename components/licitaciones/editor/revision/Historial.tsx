"use client";
// components/licitaciones/editor/revision/Historial.tsx — Las EMISIONES de la licitación (leerEmisiones,
// sin la foto). Lo emitido no se reescribe: aquí solo se ve, y se abren las copias que se subieron al
// bucket privado `licitaciones` (EnlacePrivado las firma al pintar).
//
// Una lectura fallida NUNCA se lee como «sin emisiones»: se dice que no se pudo leer y se reintenta.
import { useEffect, useState } from "react";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import { leerEmisiones, type FilaEmisionResumen } from "@/lib/licitaciones/datos";
import { CATALOGO_HALLAZGOS } from "@/lib/licitaciones/revision";
import type { HallazgoEmitido } from "@/lib/licitaciones/tipos";
import { ESTILO_GRAVEDAD, instanteLima, tamanoArchivo } from "../etiquetas";
import { BOTON_SECUNDARIO, Chip, ETIQUETA_TIPO_ARCHIVO, Nota, plural } from "./ui";
import { emisionSegura, enlaceEmitidoValido, versionMostrable } from "./emision-segura";

export type LecturaHistorial =
  | { fase: "cargando" }
  | { fase: "ok"; filas: FilaEmisionResumen[] }
  | { fase: "error"; error: string; sinMigracion?: string };

/** Lee el historial. `vez` cambia para volver a leer (tras emitir o al pulsar Reintentar). */
export function useHistorial(licId: number, vez: number): LecturaHistorial {
  const [l, setL] = useState<{ de: string; lectura: LecturaHistorial } | null>(null);
  const clave = `${licId}|${vez}`;
  useEffect(() => {
    let vivo = true;
    leerEmisiones(licId).then(
      (r) => {
        if (!vivo) return;
        // Una fila mal formada (insertada a mano) no puede romper la pantalla: arreglos reconstruidos.
        const filas = r.ok ? (Array.isArray(r.filas) ? r.filas : []).map((f) => emisionSegura(f)) : [];
        setL({ de: clave, lectura: r.ok ? { fase: "ok", filas } : { fase: "error", error: r.error, sinMigracion: r.sinMigracion } });
      },
      (e) => { if (vivo) setL({ de: clave, lectura: { fase: "error", error: `No se pudo leer las emisiones (${e instanceof Error ? e.message : String(e)}).` } }); },
    );
    return () => { vivo = false; };
  }, [licId, clave]);
  // Mientras llega la lectura de esta `vez`, se sigue enseñando la anterior si fue buena (no parpadea);
  // una anterior fallida no se repite como si fuera la respuesta nueva.
  if (!l || (l.de !== clave && l.lectura.fase === "error")) return { fase: "cargando" };
  return l.lectura;
}

const nombreHallazgo = (h: HallazgoEmitido) => CATALOGO_HALLAZGOS[h.codigo]?.titulo ?? h.codigo;

export default function Historial({ lectura, onReintentar }: { lectura: LecturaHistorial; onReintentar: () => void }) {
  if (lectura.fase === "cargando") return <p className="text-xs text-gray-500">Leyendo las emisiones anteriores…</p>;
  if (lectura.fase === "error") {
    return (
      <Nota tono={lectura.sinMigracion ? "ambar" : "rojo"}>
        <p><b>No se pudo leer el historial de emisiones.</b> {lectura.error}</p>
        {lectura.sinMigracion && <p className="mt-1">Archivo: <code className="font-mono">{lectura.sinMigracion}</code> (Supabase → SQL Editor; el deploy no corre las migraciones).</p>}
        <button type="button" onClick={onReintentar} className={`${BOTON_SECUNDARIO} mt-1.5`}>Reintentar</button>
      </Nota>
    );
  }
  if (!lectura.filas.length) return <p className="text-xs text-gray-500">Esta licitación todavía no se emitió.</p>;
  return (
    <ul className="space-y-2">
      {lectura.filas.map((e, k) => <FilaHistorial key={e.id} e={e} abierta={k === 0} />)}
    </ul>
  );
}

function FilaHistorial({ e, abierta }: { e: FilaEmisionResumen; abierta: boolean }) {
  const abiertos = e.hallazgos.filter((h) => !h.aceptado);
  const aceptados = e.hallazgos.filter((h) => h.aceptado);
  const alarmas = abiertos.filter((h) => h.gravedad === "alarma").length;
  const avisos = abiertos.filter((h) => h.gravedad === "aviso").length;
  const subidos = e.archivos.filter((a) => enlaceEmitidoValido(a.url)).length;
  const version = versionMostrable(e.version);
  const docVersion = versionMostrable(e.doc_version);
  return (
    <li className="rounded-xl border border-gray-200">
      <details open={abierta} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
          <span className="text-gray-400 group-open:hidden">▸</span><span className="hidden text-gray-400 group-open:inline">▾</span>
          <span className="font-bold text-[#0b315f]">{version != null ? `Versión ${version}` : "Versión sin número"}</span>
          <span className="text-gray-700">{instanteLima(e.emitido_en)}</span>
          <span className="text-gray-500">· {e.emitido_por_nombre ?? "usuario sin nombre"}</span>
          {docVersion != null && <span className="text-gray-400">· guardado v{docVersion}</span>}
          <Chip tono="gris">{plural(e.archivos.length, "archivo", "archivos")}{subidos < e.archivos.length ? ` · ${subidos} con copia` : ""}</Chip>
          {alarmas > 0 && <Chip tono="rojo">{plural(alarmas, "alarma abierta", "alarmas abiertas")}</Chip>}
          {avisos > 0 && <Chip tono="ambar">{plural(avisos, "aviso abierto", "avisos abiertos")}</Chip>}
          {e.omitidos.length > 0 && <Chip tono="ambar">{plural(e.omitidos.length, "omitido", "omitidos")}</Chip>}
        </summary>
        <div className="space-y-2 border-t border-gray-200 px-3 py-2 text-xs">
          {e.nota && <p className="text-gray-700"><b>Nota:</b> {e.nota}</p>}

          <div>
            <p className="mb-1 font-semibold text-gray-600">Archivos emitidos</p>
            <ul className="space-y-1">
              {e.archivos.map((a, i) => (
                <li key={`${a.nombre}|${i}`} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800 break-words">{a.nombre}</p>
                    <p className="text-[11px] text-gray-500">
                      {ETIQUETA_TIPO_ARCHIVO[a.tipo] ?? a.tipo}
                      {a.paginas != null ? ` · ${a.paginas} pág.` : ""} · {tamanoArchivo(a.bytes)}
                      {a.folios ? ` · folios ${a.folios.desde}–${a.folios.hasta}` : ""}
                      {a.sha256 ? <span className="font-mono" title={`SHA-256 ${a.sha256}`}> · {a.sha256.slice(0, 12)}…</span> : null}
                    </p>
                    {!a.url && a.motivoNoSubido && <p className="text-[11px] text-gray-500">Sin copia en el ERP: {a.motivoNoSubido}</p>}
                  </div>
                  {a.url && enlaceEmitidoValido(a.url) ? (
                    <EnlacePrivado href={a.url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1 font-bold text-[#0b315f] hover:bg-gray-50">
                      Abrir ↗
                    </EnlacePrivado>
                  ) : a.url ? (
                    <span className="shrink-0 text-[11px] text-gray-500" title="El enlace guardado no es una copia del almacenamiento de licitaciones de este ERP: no se abre.">enlace no válido</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          {e.omitidos.length > 0 && (
            <div>
              <p className="mb-1 font-semibold text-gray-600">Lo que se omitió al unir</p>
              <ul className="space-y-0.5 text-gray-700">
                {e.omitidos.map((o, i) => (
                  <li key={`${o.itemId}|${i}`}>· <b>{o.titulo}</b> — {CATALOGO_HALLAZGOS[o.codigo]?.titulo ?? o.codigo}: {o.detalle}</li>
                ))}
              </ul>
            </div>
          )}

          {abiertos.length > 0 && (
            <div>
              <p className="mb-1 font-semibold text-gray-600">Se emitió con {plural(abiertos.length, "hallazgo abierto", "hallazgos abiertos")}</p>
              <ul className="space-y-0.5">
                {abiertos.map((h) => (
                  <li key={h.clave} style={{ color: ESTILO_GRAVEDAD[h.gravedad]?.color }}>
                    <span aria-hidden="true">{ESTILO_GRAVEDAD[h.gravedad]?.icono}</span> <b>{nombreHallazgo(h)}</b>: {h.texto}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {aceptados.length > 0 && (
            <div>
              <p className="mb-1 font-semibold text-gray-600">Aceptados con nota ({aceptados.length})</p>
              <ul className="space-y-0.5 text-gray-600">
                {aceptados.map((h) => (
                  <li key={h.clave}>· <b>{nombreHallazgo(h)}</b>: {h.texto}{h.nota ? <span className="italic"> — «{h.nota}»</span> : null}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] text-gray-400">
            Firma <span className="font-mono" title={String(e.firma ?? "")}>{String(e.firma ?? "").slice(0, 16)}…</span> · carpeta <span className="font-mono">{String(e.carpeta ?? "").slice(0, 8)}…</span> · lo emitido no se reescribe.
          </p>
        </div>
      </details>
    </li>
  );
}
