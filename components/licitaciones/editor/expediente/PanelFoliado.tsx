"use client";
// components/licitaciones/editor/expediente/PanelFoliado.tsx — Las opciones de FOLIADO del expediente y
// si la propuesta va dentro del expediente completo. El ejemplo se calcula con las MISMAS funciones que
// usa la emisión (textoFolio, mapaFolios, textoRangoFolios de lib/licitaciones/pdf/expediente): lo que se
// ve aquí es lo que imprimirá, con hojas de ejemplo (las reales se cuentan al emitir).
import { mapaFolios, textoFolio, textoRangoFolios } from "@/lib/licitaciones/pdf/expediente";
import { FOLIADO_DEFECTO } from "@/lib/licitaciones/normalizar";
import type { OpcionesFoliado } from "@/lib/licitaciones/tipos";
import type { PasoProps } from "../contrato-editor";
import { conExpediente } from "./acciones";
import { Boton, CampoTexto, Casilla, claseSelect, Nota, Rotulo } from "./ui";

const MODOS: { v: OpcionesFoliado["modo"]; t: string; d: string }[] = [
  { v: "ascendente", t: "Ascendente", d: "La primera hoja lleva el 1 y la última el número más alto." },
  { v: "descendente", t: "Descendente", d: "La primera hoja lleva el número más alto y la última el 1, como piden las licitaciones del Estado." },
  { v: "ninguno", t: "Sin foliar", d: "Ninguna hoja lleva número de folio." },
];
const POSICIONES: { v: OpcionesFoliado["posicion"]; t: string }[] = [
  { v: "inferior_derecha", t: "Abajo a la derecha" },
  { v: "inferior_centro", t: "Abajo al centro" },
  { v: "superior_derecha", t: "Arriba a la derecha" },
];

/** Hojas de EJEMPLO (no medidas): la propuesta y tres bloques, cada bloque con su portada. */
const EJEMPLO = { propuesta: 30, bloques: [6, 12, 4] } as const;

export default function PanelFoliado({ p }: { p: PasoProps }) {
  const e = p.doc.expediente;
  const f = e.foliado;
  const editable = !p.soloLectura;
  const cambiar = (c: Partial<OpcionesFoliado>) => p.cambiarDoc((d) => conExpediente(d, (x) => ({ ...x, foliado: { ...x.foliado, ...c } })));
  const sinFolio = f.modo === "ninguno";
  const conPropuestaDentro = e.bloques.some((b) => b.activo && b.items.some((i) => i.incluido && i.fuente.tipo === "propuesta"));
  const esDefecto = (Object.keys(FOLIADO_DEFECTO) as (keyof OpcionesFoliado)[]).every((k) => FOLIADO_DEFECTO[k] === f[k]);

  // El ejemplo con el mismo mapa que la emisión: [propuesta si va primero] + bloques.
  const primero = e.propuestaEnCompleto === "primero";
  const paginas = [...(primero ? [EJEMPLO.propuesta] : []), ...EJEMPLO.bloques];
  const mapa = mapaFolios(paginas, f, { paginasPortada: paginas.map(() => true) });
  const rotulos = [...(primero ? ["Propuesta técnica"] : []), ...EJEMPLO.bloques.map((_, n) => `Bloque ${n + 1}`)];
  const primerFolio = mapa.todos.find((v) => v != null) ?? null;

  return (
    <section id="foliado" className="scroll-mt-24 space-y-4 rounded-2xl border border-gray-200 bg-white p-3 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-[#0b315f]">Foliado</h2>
          <p className="mt-0.5 text-xs text-gray-500">El número que lleva cada hoja del expediente. Se imprime al emitir, en el paso 5.</p>
        </div>
        {editable && !esDefecto && (
          <Boton chico tono="suave" onClick={() => cambiar({ ...FOLIADO_DEFECTO })} title="Ascendente, «Folio {n}», 3 dígitos, abajo a la derecha, con portadas">Usar el foliado por defecto</Boton>
        )}
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Orden</legend>
        {MODOS.map((m) => (
          <label key={m.v} className={`flex min-h-[40px] items-start gap-2 rounded-lg border px-2.5 py-2 text-sm ${f.modo === m.v ? "border-[#0b315f] bg-[#eef3f8]" : "border-gray-200"} ${editable ? "cursor-pointer" : ""}`}>
            <input type="radio" name="modo-foliado" className="mt-0.5 h-4 w-4 accent-[#0b315f]" checked={f.modo === m.v} disabled={!editable} onChange={() => cambiar({ modo: m.v })} />
            <span><b className="text-gray-800">{m.t}</b> <span className="text-xs text-gray-600">· {m.d}</span></span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <Rotulo texto="Texto del folio" ayuda="{n} es el número. Ej.: «Folio {n}», «Fol. {n}».">
          <CampoTexto valor={f.formato} alSalir maxLength={40} disabled={!editable || sinFolio} ariaLabel="Texto del folio"
            validar={(v) => (v.includes("{n}") ? null : `«${v}» no lleva {n} (el número): no se guardó y sigue «${f.formato}».`)}
            onCambio={(v) => cambiar({ formato: v })} />
        </Rotulo>
        <Rotulo texto="Dígitos" ayuda="Con 3, el folio 7 sale «007».">
          <select className={claseSelect} value={f.digitos} disabled={!editable || sinFolio} onChange={(ev) => cambiar({ digitos: Number(ev.target.value) })}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} ({textoFolio("{n}", 7, n)})</option>)}
          </select>
        </Rotulo>
        <Rotulo texto="Posición">
          <select className={claseSelect} value={f.posicion} disabled={!editable || sinFolio} onChange={(ev) => cambiar({ posicion: ev.target.value as OpcionesFoliado["posicion"] })}>
            {POSICIONES.map((x) => <option key={x.v} value={x.v}>{x.t}</option>)}
          </select>
        </Rotulo>
      </div>

      <div className="flex flex-col gap-1">
        <Casilla marcado={f.foliarPortadas} disabled={!editable || sinFolio} cambiar={(v) => cambiar({ foliarPortadas: v })}>
          Foliar también las portadas separadoras (y la de la propuesta)
        </Casilla>
        <Casilla marcado={f.foliarBloquesSueltos} disabled={!editable || sinFolio} cambiar={(v) => cambiar({ foliarBloquesSueltos: v })}>
          El PDF suelto de cada bloque lleva el folio que tendría en el expediente completo
        </Casilla>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">La propuesta en el expediente completo</legend>
        {([["primero", "Primero, antes de los bloques", "Cuenta para los folios de los bloques aunque solo se descarguen los bloques."], ["no", "No incluirla", "El completo lleva solo los bloques; la propuesta se descarga aparte."]] as const).map(([v, t, d]) => (
          <label key={v} className={`flex min-h-[40px] items-start gap-2 rounded-lg border px-2.5 py-2 text-sm ${e.propuestaEnCompleto === v ? "border-[#0b315f] bg-[#eef3f8]" : "border-gray-200"} ${editable ? "cursor-pointer" : ""}`}>
            <input type="radio" name="propuesta-completo" className="mt-0.5 h-4 w-4 accent-[#0b315f]" checked={e.propuestaEnCompleto === v} disabled={!editable}
              onChange={() => p.cambiarDoc((d) => conExpediente(d, (x) => ({ ...x, propuestaEnCompleto: v })))} />
            <span><b className="text-gray-800">{t}</b> <span className="text-xs text-gray-600">· {d}</span></span>
          </label>
        ))}
      </fieldset>
      {primero && conPropuestaDentro && (
        <Nota tono="ambar">Un bloque activo también lleva la propuesta técnica: en el expediente completo saldría dos veces. Quita ese ítem o elige «No incluirla».</Nota>
      )}

      {/* ── Ejemplo ── */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Cómo se verá</p>
        {sinFolio ? (
          <p className="mt-1 text-xs text-gray-600">Sin foliar: ninguna hoja lleva número.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-start gap-4">
            <HojaEjemplo texto={primerFolio != null ? textoFolio(f.formato, primerFolio, f.digitos) : "—"} posicion={f.posicion} />
            <div className="min-w-0 flex-1 space-y-1 text-xs text-gray-700">
              <p>
                Ejemplo con {primero ? `una propuesta de ${EJEMPLO.propuesta} hojas y ` : ""}tres bloques de {EJEMPLO.bloques.join(", ")} hojas, cada uno con su portada
                (las hojas reales se cuentan al emitir):
              </p>
              <ul className="space-y-0.5">
                {rotulos.map((r, n) => (
                  <li key={r} className="flex justify-between gap-3 border-b border-gray-200 py-0.5 font-mono text-[11px]">
                    <span className="font-sans">{r}</span>
                    <span>{textoRangoFolios(mapa.porBloque[n], f.digitos)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-gray-500">
                {mapa.total} hojas foliadas.{!f.foliarPortadas ? " Las portadas no llevan número ni lo consumen." : ""}
                {primerFolio != null ? ` La primera dice «${textoFolio(f.formato, primerFolio, f.digitos)}».` : ""}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Una hoja A4 en miniatura con el folio en su esquina. */
function HojaEjemplo({ texto, posicion }: { texto: string; posicion: OpcionesFoliado["posicion"] }) {
  const pos = posicion === "superior_derecha" ? "top-2 right-2" : posicion === "inferior_centro" ? "bottom-2 left-1/2 -translate-x-1/2" : "bottom-2 right-2";
  return (
    <div className="relative h-40 w-28 shrink-0 rounded border border-gray-300 bg-white shadow-sm" aria-label={`Hoja de ejemplo con el folio «${texto}»`}>
      <div className="space-y-1.5 p-3" aria-hidden="true">
        {[90, 70, 85, 60, 80, 50].map((w, n) => <div key={n} className="h-1 rounded bg-gray-200" style={{ width: `${w}%` }} />)}
      </div>
      <span className={`absolute ${pos} whitespace-nowrap rounded-sm border border-gray-500 bg-white px-1 text-[8px] font-bold text-gray-900`}>{texto}</span>
    </div>
  );
}
