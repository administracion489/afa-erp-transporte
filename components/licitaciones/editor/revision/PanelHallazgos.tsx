"use client";
// components/licitaciones/editor/revision/PanelHallazgos.tsx — Los HALLAZGOS de toda la licitación
// (panel `hallazgos`). Los da el motor (lib/licitaciones/revision.ts); aquí se cuentan, se filtran, se
// agrupan por DÓNDE se corrigen y se aceptan con nota.
//
// Reglas de la pantalla:
//  · Mientras no hay revisión se dice «comprobando…»: nunca «sin hallazgos» sin haber revisado.
//  · `fuente_no_leida` va arriba del todo y fuera de los filtros: sin esos datos el resto no es de fiar.
//  · Ningún hallazgo bloquea la emisión (D7). Aceptar uno pide una NOTA (por qué se presenta igual) y
//    queda en `doc.aceptados`: un aceptado se sigue viendo, en gris, con su nota.
import Link from "next/link";
import { useMemo, useState } from "react";
import type { DocLicitacion, Gravedad, Hallazgo, Paso, Revision } from "@/lib/licitaciones/tipos";
import { ESTILO_GRAVEDAD, ETIQUETA_PASO, instanteLima } from "../etiquetas";
import {
  FILTRO_INICIAL, GRUPOS, aceptable, aceptacionesSinHallazgo, agrupar, contar, cuentaPorGrupo, esFuenteNoLeida,
  type FiltroHallazgos, type GrupoHallazgo,
} from "./resumen";
import { BOTON_PRIMARIO, BOTON_SECUNDARIO, Chip, Nota, Seccion, plural, tonoDeGravedad } from "./ui";

/** Tope de la nota (normalizarDoc la recorta a 1000). */
const MAX_NOTA = 1000;
/** Una nota de menos de esto no dice por qué («ok», «ya»). */
const MIN_NOTA = 8;

const TITULO_GRUPO: Record<GrupoHallazgo, string> = {
  bases: `${ETIQUETA_PASO.bases.n} · ${ETIQUETA_PASO.bases.largo}`,
  recursos: `${ETIQUETA_PASO.recursos.n} · ${ETIQUETA_PASO.recursos.largo}`,
  contenido: `${ETIQUETA_PASO.contenido.n} · ${ETIQUETA_PASO.contenido.largo}`,
  expediente: `${ETIQUETA_PASO.expediente.n} · ${ETIQUETA_PASO.expediente.largo}`,
  revision: `${ETIQUETA_PASO.revision.n} · ${ETIQUETA_PASO.revision.largo}`,
  fuera: "En otras pantallas del ERP",
};

type Props = {
  revision: Revision | null;
  ctxCargando: boolean;
  doc: DocLicitacion;
  soloLectura: boolean;
  irA: (p: Paso, ancla?: string | null) => void;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  recargarCtx: () => void;
  aviso: (texto: string, tono?: "ok" | "error" | "aviso") => void;
  /** Quién acepta (usuarios.nombre); null si no se supo. */
  nombreUsuario: string | null;
  /** «Incluye la comprobación de archivos de las…», o null si la revisión no la incluye. */
  conArchivos: string | null;
};

export default function PanelHallazgos(p: Props) {
  const { revision } = p;
  const [filtro, setFiltro] = useState<FiltroHallazgos>(FILTRO_INICIAL);
  const [aceptando, setAceptando] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [verHuerfanas, setVerHuerfanas] = useState(false);

  const grupos = useMemo(() => (revision ? agrupar(revision, filtro) : []), [revision, filtro]);
  const conteo = useMemo(() => (revision ? contar(revision) : null), [revision]);
  const porGrupo = useMemo(() => (revision ? cuentaPorGrupo(revision, filtro) : null), [revision, filtro]);
  const fuentes = useMemo(() => (revision?.hallazgos ?? []).filter(esFuenteNoLeida), [revision]);
  const huerfanas = useMemo(() => (revision ? aceptacionesSinHallazgo(p.doc, revision) : []), [p.doc, revision]);

  const abrirAceptar = (h: Hallazgo) => { setAceptando(h.clave); setNota(""); };
  const cerrarAceptar = () => { setAceptando(null); setNota(""); };

  const guardarAceptacion = (h: Hallazgo) => {
    const t = nota.trim();
    if (t.length < MIN_NOTA) return;
    if (p.doc.aceptados.length >= 1000 && !p.doc.aceptados.some((a) => a.clave === h.clave)) {
      p.aviso("Ya hay 1000 hallazgos aceptados en esta licitación: quita alguna aceptación antigua antes de agregar otra.", "error");
      return;
    }
    const en = new Date().toISOString();
    p.cambiarDoc((d) => ({ ...d, aceptados: [...d.aceptados.filter((a) => a.clave !== h.clave), { clave: h.clave, nota: t.slice(0, MAX_NOTA), por: p.nombreUsuario, en }] }));
    cerrarAceptar();
    p.aviso(`Aceptado: «${h.titulo}». Queda registrado con tu nota en la próxima emisión.`);
  };

  const quitarAceptacion = (clave: string, titulo: string, notaVieja: string) => {
    if (!window.confirm(`¿Quitar la aceptación de «${titulo}»?\n\nSe borra la nota: «${notaVieja}».\nEl hallazgo vuelve a contar como abierto.`)) return;
    p.cambiarDoc((d) => ({ ...d, aceptados: d.aceptados.filter((a) => a.clave !== clave) }));
  };

  if (!revision || !conteo || !porGrupo) {
    return (
      <Seccion id="hallazgos" titulo="Hallazgos de la licitación">
        <p className="text-xs text-gray-500">
          {p.ctxCargando
            ? "Comprobando la licitación contra lo que el ERP sabe hoy…"
            : "La revisión no está disponible todavía (no se pudo leer lo que el ERP sabe de la licitación): nada se da por cumplido ni por faltante."}
        </p>
      </Seccion>
    );
  }

  const totalAbiertos = conteo.abiertos.alarma + conteo.abiertos.aviso + conteo.abiertos.info;
  const nada = totalAbiertos === 0 && conteo.aceptados === 0;
  const filtrando = filtro.grupo !== "todos" || !filtro.gravedad.alarma || !filtro.gravedad.aviso || !filtro.gravedad.info || !filtro.verAceptados;

  return (
    <Seccion
      id="hallazgos"
      titulo="Hallazgos de la licitación"
      subtitulo={<>
        Vigencias medidas al <b>{revision.referenciaEs === "presentacion" ? "día de presentación" : "día de hoy (falta la fecha de presentación)"}</b>.
        {p.conArchivos ? ` ${p.conArchivos}` : " Sin comprobar los archivos (se comprueban abajo o al emitir)."}
        {" "}Ningún hallazgo impide emitir: se corrige o se acepta con una nota, y queda registrado en la emisión.
      </>}
    >
      {/* Fuentes que no se pudieron leer: arriba de todo */}
      {fuentes.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-bold text-amber-900">
            No se pudo leer {fuentes.length === 1 ? "una parte" : `${fuentes.length} partes`} del ERP: sin esos datos el resto de la revisión no es de fiar.
          </p>
          <ul className="space-y-0.5 text-xs text-amber-900">
            {fuentes.map((h) => <li key={h.clave}>· {h.texto}</li>)}
          </ul>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={p.recargarCtx} disabled={p.ctxCargando} className={BOTON_SECUNDARIO}>
              {p.ctxCargando ? "Leyendo…" : "Volver a leer los datos"}
            </button>
            <span className="text-[11px] text-amber-800">Si sigue igual, recarga la página o corre la migración que se nombra.</span>
          </div>
        </div>
      )}

      {/* Conteo */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {nada ? (
          <Nota tono={fuentes.length ? "gris" : "verde"}>
            {fuentes.length ? "Con lo que se pudo leer, la revisión no encuentra nada que corregir." : "La revisión no encuentra nada que corregir."}
          </Nota>
        ) : (
          <>
            <span className="font-semibold text-gray-700">Abiertos:</span>
            <Chip tono={conteo.abiertos.alarma ? "rojo" : "gris"}>{plural(conteo.abiertos.alarma, "alarma", "alarmas")}</Chip>
            <Chip tono={conteo.abiertos.aviso ? "ambar" : "gris"}>{plural(conteo.abiertos.aviso, "aviso", "avisos")}</Chip>
            <Chip tono={conteo.abiertos.info ? "azul" : "gris"}>{conteo.abiertos.info} info</Chip>
            {conteo.aceptados > 0 && <Chip tono="gris">{plural(conteo.aceptados, "aceptado", "aceptados")}</Chip>}
          </>
        )}
      </div>

      {/* Filtros */}
      {!nada && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-gray-500">Gravedad:</span>
            {(["alarma", "aviso", "info"] as Gravedad[]).map((g) => {
              const e = ESTILO_GRAVEDAD[g];
              const on = filtro.gravedad[g];
              return (
                <button key={g} type="button" aria-pressed={on}
                  onClick={() => setFiltro((f) => ({ ...f, gravedad: { ...f.gravedad, [g]: !f.gravedad[g] } }))}
                  className="rounded-lg border px-2 py-1 font-bold"
                  style={on ? { background: e.bg, borderColor: e.bd, color: e.color } : { background: "#fff", borderColor: "#e5e7eb", color: "#9ca3af", textDecoration: "line-through" }}>
                  <span aria-hidden="true">{e.icono}</span> {e.texto}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Dónde se corrige:</span>
            <select value={filtro.grupo} onChange={(e) => setFiltro((f) => ({ ...f, grupo: e.target.value as FiltroHallazgos["grupo"] }))}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs">
              <option value="todos">Todos los pasos</option>
              {GRUPOS.map((g) => <option key={g} value={g}>{TITULO_GRUPO[g]} ({porGrupo[g]})</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filtro.verAceptados} onChange={(e) => setFiltro((f) => ({ ...f, verAceptados: e.target.checked }))} />
            <span>Mostrar aceptados</span>
          </label>
          {filtrando && (
            <button type="button" onClick={() => setFiltro(FILTRO_INICIAL)} className="font-bold text-[#0b315f] underline">Quitar filtros</button>
          )}
        </div>
      )}

      {/* Lista agrupada */}
      {!nada && grupos.length === 0 && (
        <p className="text-xs text-gray-500">Ningún hallazgo con estos filtros.</p>
      )}
      {grupos.map(({ grupo, hallazgos }) => (
        <div key={grupo}>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{TITULO_GRUPO[grupo]} · {hallazgos.length}</p>
          <ul className="space-y-1.5">
            {hallazgos.map((h) => (
              <ItemHallazgo
                key={h.clave} h={h} irA={p.irA} soloLectura={p.soloLectura}
                abierto={aceptando === h.clave} nota={nota} setNota={setNota}
                onAceptar={() => abrirAceptar(h)} onCancelar={cerrarAceptar} onGuardar={() => guardarAceptacion(h)}
                onQuitar={() => h.aceptado && quitarAceptacion(h.clave, h.titulo, h.aceptado.nota)}
              />
            ))}
          </ul>
        </div>
      ))}

      {/* Aceptaciones de hallazgos que ya no aparecen */}
      {huerfanas.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <button type="button" onClick={() => setVerHuerfanas((v) => !v)} className="font-bold underline">
            {verHuerfanas ? "Ocultar" : "Ver"} {plural(huerfanas.length, "aceptación guardada", "aceptaciones guardadas")} de hallazgos que la revisión ya no da
          </button>
          <span className="ml-1">(se resolvieron, o su fuente no se pudo leer: si vuelven a salir, siguen aceptados).</span>
          {verHuerfanas && (
            <ul className="mt-1.5 space-y-1">
              {huerfanas.map((a) => (
                <li key={a.clave} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-[10px] text-gray-400 break-all">{a.clave.split("|")[0]}</span>
                    <span className="block">«{a.nota}»{a.por ? ` · ${a.por}` : ""} · {instanteLima(a.en)}</span>
                  </span>
                  {!p.soloLectura && (
                    <button type="button" onClick={() => quitarAceptacion(a.clave, a.clave.split("|")[0], a.nota)} className="shrink-0 font-bold text-gray-500 underline">Quitar</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Seccion>
  );
}

function ItemHallazgo({ h, irA, soloLectura, abierto, nota, setNota, onAceptar, onCancelar, onGuardar, onQuitar }: {
  h: Hallazgo; irA: Props["irA"]; soloLectura: boolean; abierto: boolean; nota: string; setNota: (s: string) => void;
  onAceptar: () => void; onCancelar: () => void; onGuardar: () => void; onQuitar: () => void;
}) {
  const e = ESTILO_GRAVEDAD[h.gravedad];
  const a = h.aceptado;
  const d = h.donde;
  // Un ancla que apunta a este mismo panel (fuente_no_leida, archivo_cambio_desde_emision) no lleva a nada.
  const haciaEsteSitio = "paso" in d && d.paso === "revision" && (!d.ancla || d.ancla === "hallazgos");
  const faltaNota = nota.trim().length < MIN_NOTA;
  return (
    <li className="rounded-xl border px-3 py-2 text-xs" style={a ? { background: "#f9fafb", borderColor: "#e5e7eb", color: "#6b7280" } : { background: e.bg, borderColor: e.bd, color: e.color }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-bold">
            <span aria-hidden="true">{e.icono}</span> {h.titulo}
            {h.sujeto.rotulo && <span className="font-normal opacity-80"> · {h.sujeto.rotulo}</span>}
          </p>
          <p className="mt-0.5 opacity-90">{h.texto}</p>
          {!a && <p className="mt-0.5 opacity-75">Cómo se arregla: {h.arreglo}</p>}
          {a && (
            <p className="mt-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-gray-600">
              <b>Aceptado</b>{a.por ? ` por ${a.por}` : ""} el {instanteLima(a.en)}: «{a.nota}»
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {a ? <Chip tono="gris">aceptado</Chip> : <Chip tono={tonoDeGravedad(h.gravedad)}>{e.texto}</Chip>}
          {"ruta" in d ? (
            <Link href={d.ruta} target="_blank" rel="noopener noreferrer" className="rounded-lg border bg-white px-2.5 py-1 font-bold hover:bg-gray-50" style={{ borderColor: a ? "#e5e7eb" : e.bd }}>
              Abrir {d.etiqueta} ↗
            </Link>
          ) : !haciaEsteSitio ? (
            <button type="button" onClick={() => irA(d.paso, d.ancla)} className="rounded-lg border bg-white px-2.5 py-1 font-bold hover:bg-gray-50" style={{ borderColor: a ? "#e5e7eb" : e.bd }}>
              Ir a corregir en {ETIQUETA_PASO[d.paso].corto} →
            </button>
          ) : null}
          {!soloLectura && !a && aceptable(h) && !abierto && (
            <button type="button" onClick={onAceptar} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 font-bold text-gray-700 hover:bg-gray-50">Aceptar…</button>
          )}
          {!soloLectura && a && (
            <button type="button" onClick={onQuitar} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 font-bold text-gray-600 hover:bg-gray-50">Quitar aceptación</button>
          )}
        </div>
      </div>
      {abierto && (
        <div className="mt-2 space-y-1.5 rounded-lg border border-gray-200 bg-white p-2 text-gray-700">
          <label className="block">
            <span className="font-bold">¿Por qué se presenta igual?</span>
            <span className="block text-[11px] text-gray-500">La nota queda registrada en la emisión junto al hallazgo. Ejemplo: «El cliente confirmó por correo que acepta la unidad de 2014».</span>
            <textarea value={nota} maxLength={MAX_NOTA} rows={2} autoFocus onChange={(ev) => setNota(ev.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onGuardar} disabled={faltaNota} className={BOTON_PRIMARIO}>Aceptar con esta nota</button>
            <button type="button" onClick={onCancelar} className={BOTON_SECUNDARIO}>Cancelar</button>
            <span className="text-[11px] text-gray-500">
              {faltaNota ? `Escribe el motivo (al menos ${MIN_NOTA} caracteres) para poder aceptarlo.` : `${nota.trim().length} de ${MAX_NOTA} caracteres.`}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}
