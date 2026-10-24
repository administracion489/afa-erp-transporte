"use client";
// components/licitaciones/editor/expediente/PartesItem.tsx — Lo que SALE de un ítem del expediente, tal
// como lo dice resolverExpediente: los archivos que se unen, las hojas que arma el ERP y lo que no sale
// con su motivo (el código del motor) y el sitio donde se arregla.
//
// Lo que no sale va siempre a la vista (es lo que hay que arreglar); lo que sí sale, plegado.
// Mientras se lee el ERP se dice «comprobando…»: nunca se afirma que falte nada sin haber leído.
import Link from "next/link";
import { useState } from "react";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import type { ItemExpediente, ParteFuente } from "@/lib/licitaciones/tipos";
import type { PasoProps } from "../contrato-editor";
import { arregloDe, claseParte, contarPartes, frasesCuenta, motivoFaltante, TONO_CLASE, type Arreglo } from "./partes";
import { Chip } from "./ui";

type Props = {
  p: PasoProps;
  item: ItemExpediente;
  /** undefined = no se pudo resolver todavía (sin contexto o el bloque no está activo). */
  partes: ParteFuente[] | undefined;
  bloqueActivo: boolean;
  resuelto: boolean;
};

export default function PartesItem({ p, item, partes, bloqueActivo, resuelto }: Props) {
  const [verOk, setVerOk] = useState(false);
  if (!bloqueActivo) return <p className="text-[11px] text-gray-500">El bloque está desactivado: este documento no sale.</p>;
  if (!item.incluido) return <p className="text-[11px] text-gray-500">No incluido: no sale en el expediente ni en el «Contenido» de la portada separadora.</p>;
  if (!resuelto) return <p className="text-[11px] text-gray-500">{p.ctxCargando ? "Comprobando qué saldrá…" : "Todavía no se sabe qué saldrá: no se pudo leer lo que el ERP sabe de esta licitación."}</p>;

  const xs = partes ?? [];
  if (!xs.length) return <p className="text-[11px] text-amber-800">{vacio(p, item)}</p>;

  const malas = xs.filter((x) => { const c = claseParte(x); return c === "falta" || c === "externo" || c === "no_leido"; });
  const buenas = xs.filter((x) => !malas.includes(x));
  const frases = frasesCuenta(contarPartes(xs));
  const hayRuta = malas.some((x) => x.tipo === "faltante" && arregloDe(item.fuente, x.codigo)?.tipo === "ruta");

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[11px] font-semibold text-gray-500">Saldrá:</span>
        {frases.map((f) => <Chip key={f.clase} tono={TONO_CLASE[f.clase]}>{f.texto}</Chip>)}
        {buenas.some((x) => x.tipo !== "propuesta") && (
          <button type="button" onClick={() => setVerOk((v) => !v)} className="text-[11px] font-semibold text-[#0b315f] underline">
            {verOk ? "ocultar" : buenas.length === 1 ? "ver cuál" : `ver los ${buenas.length}`}
          </button>
        )}
      </div>
      {malas.length > 0 && (
        <ul className="space-y-1">
          {malas.map((x, k) => x.tipo === "faltante" ? (
            <li key={`${x.titulo}-${k}`} className={`rounded-lg border px-2 py-1.5 text-xs ${claseParte(x) === "falta" ? "border-red-200 bg-red-50 text-red-800" : claseParte(x) === "externo" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-gray-200 bg-gray-50 text-gray-600"}`}>
              <span className="block break-words font-semibold">{x.titulo}</span>
              <span className="break-words">{motivoFaltante(x.codigo)}</span>
              <AccionArreglo p={p} a={arregloDe(item.fuente, x.codigo)} />
            </li>
          ) : null)}
        </ul>
      )}
      {hayRuta && (
        <p className="text-[11px] text-gray-500">
          ¿Ya lo subiste en la otra pestaña?{" "}
          <button type="button" onClick={p.recargarCtx} disabled={p.ctxCargando} className="font-semibold text-[#0b315f] underline disabled:opacity-50">
            {p.ctxCargando ? "Comprobando…" : "Volver a comprobar"}
          </button>
        </p>
      )}
      {verOk && buenas.length > 0 && (
        <ul className="space-y-0.5 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5">
          {buenas.map((x, k) => <ParteBuena key={k} x={x} />)}
        </ul>
      )}
    </div>
  );
}

function ParteBuena({ x }: { x: ParteFuente }) {
  switch (x.tipo) {
    case "archivo":
      return (
        <li className="flex flex-wrap items-center gap-x-2 text-xs text-gray-700">
          <span className="text-emerald-700">✓</span>
          <span className="min-w-0 break-words">{x.titulo}</span>
          <span className="text-[11px] text-gray-400">{x.etiquetaFuente}</span>
          <EnlacePrivado href={x.url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-semibold text-[#0b315f] underline">Ver</EnlacePrivado>
        </li>
      );
    case "ficha_unidad":
      return <li className="text-xs text-gray-700">▣ Ficha técnica · {x.ficha.codigo || "Unidad"} · {x.ficha.placa} <span className="text-[11px] text-gray-400">(la arma el ERP)</span></li>;
    case "cuadro_experiencia": {
      const n = x.cuadro.tabla.filas.length;
      return <li className="text-xs text-gray-700">▣ Cuadro de experiencia · {n} contrato{n === 1 ? "" : "s"} {n === 0 && <Chip tono="ambar">saldrá sin filas</Chip>}</li>;
    }
    case "tabla": {
      const n = x.tabla.filas.length;
      return <li className="text-xs text-gray-700">▣ {x.titulo} · {n} fila{n === 1 ? "" : "s"} {n === 0 && <Chip tono="ambar">saldrá sin filas</Chip>}</li>;
    }
    case "propuesta":
      return <li className="text-xs text-gray-700">▣ La propuesta técnica (paso 3)</li>;
    default:
      return null;
  }
}

function AccionArreglo({ p, a }: { p: PasoProps; a: Arreglo | null }) {
  if (!a) return null;
  const cls = "ml-1 text-[11px] font-semibold underline";
  switch (a.tipo) {
    case "paso": return <button type="button" onClick={() => p.irA(a.paso, a.ancla)} className={cls}>{a.etiqueta} →</button>;
    case "ruta": return <Link href={a.ruta} target="_blank" rel="noopener noreferrer" className={cls}>{a.etiqueta} ↗</Link>;
    case "releer": return <button type="button" onClick={p.recargarCtx} disabled={p.ctxCargando} className={`${cls} disabled:opacity-50`}>{p.ctxCargando ? "Comprobando…" : a.etiqueta}</button>;
    case "aqui": return <span className="ml-1 text-[11px]">({a.etiqueta})</span>;
  }
}

/** Por qué un ítem incluido no saca nada (es un hecho del doc, no un juicio). */
function vacio(p: PasoProps, item: ItemExpediente): string {
  const f = item.fuente;
  switch (f.tipo) {
    case "docs_unidades": case "fotos_unidades": case "fichas_unidades":
      return "No saldrá nada: no hay unidades con ese rol elegidas en Recursos.";
    case "docs_conductores":
      return "No saldrá nada: no hay conductores con ese rol elegidos en Recursos.";
    case "sustentos_experiencia":
      return p.doc.experiencia.ids.length === 0
        ? "No saldrá nada: no hay contratos elegidos en Recursos → Experiencia."
        : "No saldrá nada: ninguno de los contratos elegidos tiene sustentos de esa clase.";
    default:
      return "No saldrá nada de este ítem.";
  }
}
