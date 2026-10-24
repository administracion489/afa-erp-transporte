"use client";
// components/licitaciones/editor/bases/EditorRegla.tsx — La REGLA verificable de un requisito, del
// catálogo cerrado (TIPOS_REGLA). Se edita como BORRADOR: al doc solo va una regla COMPLETA y válida
// (pasada por normalizarRegla, la misma que aplica el guardado). Una regla a medias va al doc como
// «sin regla» y la pantalla lo dice: lo que se guarda es lo que se evalúa, nunca una regla que el
// guardado descartaría en silencio. El borrador se deriva en el render (sin efectos): si la regla
// cambia desde fuera, manda la de fuera.
import { useState } from "react";
import { CATEGORIAS_CLASE_A } from "@/lib/licencias-conducir";
import { normalizarRegla } from "@/lib/licitaciones/normalizar";
import { describirRegla, ETIQUETA_REGLA, ETIQUETA_SEGURO_LIC } from "@/lib/licitaciones/reglas";
import { DOCS_CONDUCTOR_REGLA, TIPOS_SEGURO_LIC } from "@/lib/licitaciones/analisis";
import { TIPOS_LEGAJO, tipoLegajo, tipoDocConductor } from "@/lib/licitaciones/legajo";
import { ETIQUETA_DOC_UNIDAD } from "@/lib/licitaciones/recursos";
import {
  CODIGOS_LEGAJO, DOCS_UNIDAD_LIC, TIPOS_REGLA,
  type CategoriaLicencia, type CodigoLegajo, type FechaReferencia, type Moneda, type Regla, type TipoRegla,
} from "@/lib/licitaciones/tipos";
import { leerNumero, motivoNumero } from "./CampoEntero";
import { INPUT } from "./ui";

type Borrador = {
  tipo: TipoRegla | "";
  legajo: string; antig: string; anios: string; referencia: FechaReferencia; asientos: string; uso: string;
  doc: string; vigenteAl: FechaReferencia; n: string; categorias: CategoriaLicencia[];
  desde: "primer_contrato" | "constitucion"; monto: string; moneda: Moneda; seguro: string;
};

const VACIO: Borrador = {
  tipo: "", legajo: "", antig: "", anios: "", referencia: "presentacion", asientos: "", uso: "", doc: "",
  vigenteAl: "presentacion", n: "", categorias: [], desde: "primer_contrato", monto: "", moneda: "PEN", seguro: "",
};

/** Rangos: los MISMOS de normalizarRegla (lib/licitaciones/normalizar.ts). */
const R = { antig: [1, 3650], uAnios: [0, 60], asientos: [1, 120], n: [1, 500], eAnios: [1, 100], monto: [0.01, 1e12] } as const;

export function borradorDe(r: Regla | null): Borrador {
  if (!r) return VACIO;
  const b: Borrador = { ...VACIO, tipo: r.tipo };
  switch (r.tipo) {
    case "doc_empresa": b.legajo = r.legajo; b.antig = r.antiguedadMaxDias == null ? "" : String(r.antiguedadMaxDias); break;
    case "unidad_antiguedad_max": b.anios = String(r.anios); b.referencia = r.referencia; break;
    case "unidad_capacidad_min": b.asientos = String(r.asientos); b.uso = r.uso ?? ""; break;
    case "unidad_doc": b.doc = r.doc; b.vigenteAl = r.vigenteAl; break;
    case "unidades_titulares_min": case "unidades_reten_min": case "conductores_relevo_min": case "experiencia_cartas_min": b.n = String(r.n); break;
    case "conductor_licencia": b.categorias = [...r.categorias]; break;
    case "conductor_doc": b.doc = r.doc; b.antig = r.antiguedadMaxDias == null ? "" : String(r.antiguedadMaxDias); break;
    case "experiencia_anios_min": b.anios = String(r.anios); b.desde = r.desde; break;
    case "experiencia_monto_min": b.monto = String(r.monto); b.moneda = r.moneda; break;
    case "experiencia_ventana_anios": b.anios = String(r.anios); break;
    case "seguro": b.seguro = r.seguro; b.vigenteAl = r.vigenteAl; break;
  }
  return b;
}

type Lectura = { regla: Regla | null; falta: string | null };

/** La regla del borrador, o qué le falta. */
export function reglaDeBorrador(b: Borrador): Lectura {
  if (!b.tipo) return { regla: null, falta: null };
  const req = (txt: string, [min, max]: readonly [number, number], que: string): number | string => {
    if (!txt.trim()) return `falta ${que}`;
    const m = motivoNumero(txt, min, max, false);
    return m ? `${que}: ${m.toLowerCase()}` : leerNumero(txt, false);
  };
  const opc = (txt: string, rango: readonly [number, number], que: string): number | null | string => (txt.trim() ? req(txt, rango, que) : null);
  let crudo: Record<string, unknown>;
  const mal = (x: unknown): x is string => typeof x === "string";
  switch (b.tipo) {
    case "doc_empresa": {
      if (!(CODIGOS_LEGAJO as readonly string[]).includes(b.legajo)) return { regla: null, falta: "elige el documento del legajo" };
      const a = opc(b.antig, R.antig, "la antigüedad máxima"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, legajo: b.legajo, antiguedadMaxDias: a }; break;
    }
    case "unidad_antiguedad_max": {
      const a = req(b.anios, R.uAnios, "los años de antigüedad máxima"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, anios: a, referencia: b.referencia }; break;
    }
    case "unidad_capacidad_min": {
      const a = req(b.asientos, R.asientos, "los asientos mínimos"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, asientos: a, uso: b.uso.trim() || null }; break;
    }
    case "unidad_doc":
      if (!(DOCS_UNIDAD_LIC as readonly string[]).includes(b.doc)) return { regla: null, falta: "elige el documento de la unidad" };
      crudo = { tipo: b.tipo, doc: b.doc, vigenteAl: b.vigenteAl }; break;
    case "unidad_fotos": case "prohibe_subcontratacion":
      crudo = { tipo: b.tipo }; break;
    case "unidades_titulares_min": case "unidades_reten_min": case "conductores_relevo_min": case "experiencia_cartas_min": {
      const a = req(b.n, R.n, "la cantidad mínima"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, n: a }; break;
    }
    case "conductor_licencia":
      if (!b.categorias.length) return { regla: null, falta: "marca al menos una categoría de licencia" };
      crudo = { tipo: b.tipo, categorias: b.categorias }; break;
    case "conductor_doc": {
      if (!(DOCS_CONDUCTOR_REGLA as readonly string[]).includes(b.doc)) return { regla: null, falta: "elige el documento del conductor" };
      const a = opc(b.antig, R.antig, "la antigüedad máxima"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, doc: b.doc, antiguedadMaxDias: a }; break;
    }
    case "experiencia_anios_min": {
      const a = req(b.anios, R.eAnios, "los años mínimos"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, anios: a, desde: b.desde }; break;
    }
    case "experiencia_monto_min": {
      if (!b.monto.trim()) return { regla: null, falta: "falta el monto mínimo" };
      const m = motivoNumero(b.monto, R.monto[0], R.monto[1], true);
      if (m) return { regla: null, falta: `el monto: ${m.toLowerCase()}` };
      crudo = { tipo: b.tipo, monto: Math.round(leerNumero(b.monto, true) * 100) / 100, moneda: b.moneda }; break;
    }
    case "experiencia_ventana_anios": {
      const a = req(b.anios, R.eAnios, "los años de la ventana"); if (mal(a)) return { regla: null, falta: a };
      crudo = { tipo: b.tipo, anios: a }; break;
    }
    case "seguro":
      if (!(TIPOS_SEGURO_LIC as readonly string[]).includes(b.seguro)) return { regla: null, falta: "elige el seguro" };
      crudo = { tipo: b.tipo, seguro: b.seguro, vigenteAl: b.vigenteAl }; break;
  }
  const regla = normalizarRegla(crudo);
  return regla ? { regla, falta: null } : { regla: null, falta: "los parámetros no son válidos" };
}

const json = (r: Regla | null) => JSON.stringify(r);

type Props = { regla: Regla | null; onCambio: (r: Regla | null) => void; soloLectura: boolean; idBase: string };

export default function EditorRegla({ regla, onCambio, soloLectura, idBase }: Props) {
  const propJson = json(regla);
  const [st, setSt] = useState<{ b: Borrador; base: string }>({ b: borradorDe(regla), base: propJson });
  const b = st.base === propJson ? st.b : borradorDe(regla);
  const lectura = reglaDeBorrador(b);

  const cambiar = (parche: Partial<Borrador>) => {
    const nb = { ...b, ...parche };
    const l = reglaDeBorrador(nb);
    const entrega = l.regla;
    setSt({ b: nb, base: json(entrega) });
    if (json(entrega) !== propJson) onCambio(entrega);
  };
  const elegirTipo = (t: TipoRegla | "") => {
    // Cambiar de tipo empieza de cero (los parámetros de otra regla no significan lo mismo).
    cambiar({ ...VACIO, tipo: t });
  };

  const sel = "py-1.5 text-xs";
  const id = (s: string) => `${idBase}-${s}`;
  const refSel = (valor: FechaReferencia, k: "referencia" | "vigenteAl", etiqueta: string) => (
    <label className="block min-w-0">
      <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{etiqueta}</span>
      <select className={`${INPUT} ${sel}`} value={valor} disabled={soloLectura} onChange={(e) => cambiar({ [k]: e.target.value as FechaReferencia })}>
        <option value="presentacion">a la presentación</option>
        <option value="inicio_servicio">al inicio del servicio</option>
      </select>
    </label>
  );
  const num = (k: "antig" | "anios" | "asientos" | "n" | "monto", etiqueta: string, ayuda?: string) => (
    <label className="block min-w-0" htmlFor={id(k)}>
      <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{etiqueta}</span>
      <input id={id(k)} type="text" inputMode={k === "monto" ? "decimal" : "numeric"} className={`${INPUT} ${sel}`} value={b[k]} disabled={soloLectura}
        onChange={(e) => cambiar({ [k]: e.target.value })} />
      {ayuda && <span className="block text-[10px] text-gray-400 mt-0.5">{ayuda}</span>}
    </label>
  );

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">Regla que comprueba el ERP</span>
        <select className={`${INPUT} ${sel}`} value={b.tipo} disabled={soloLectura} onChange={(e) => elegirTipo(e.target.value as TipoRegla | "")}>
          <option value="">— Sin regla (lo marca una persona)</option>
          {TIPOS_REGLA.map((t) => <option key={t} value={t}>{ETIQUETA_REGLA[t]}</option>)}
        </select>
      </label>

      {b.tipo && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {b.tipo === "doc_empresa" && (<>
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Documento del legajo</span>
              <select className={`${INPUT} ${sel}`} value={b.legajo} disabled={soloLectura}
                onChange={(e) => {
                  const nuevo = e.target.value;
                  const antes = b.legajo && (CODIGOS_LEGAJO as readonly string[]).includes(b.legajo) ? tipoLegajo(b.legajo as CodigoLegajo).antiguedadSugeridaDias : null;
                  const sug = (CODIGOS_LEGAJO as readonly string[]).includes(nuevo) ? tipoLegajo(nuevo as CodigoLegajo).antiguedadSugeridaDias : null;
                  // La antigüedad sugerida se propone solo si el campo estaba vacío o con la sugerida anterior.
                  const antig = !b.antig.trim() || (antes != null && b.antig.trim() === String(antes)) ? (sug != null ? String(sug) : "") : b.antig;
                  cambiar({ legajo: nuevo, antig });
                }}>
                <option value="">— elige</option>
                {[...new Set(TIPOS_LEGAJO.map((t) => t.grupo))].map((g) => (
                  <optgroup key={g} label={g}>
                    {TIPOS_LEGAJO.filter((t) => t.grupo === g).map((t) => <option key={t.codigo} value={t.codigo}>{t.etiqueta}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            {num("antig", "Antigüedad máxima (días)", "Vacío = sin tope. La sugerida es una costumbre, no una norma: pon la de tus bases.")}
          </>)}
          {b.tipo === "unidad_antiguedad_max" && (<>{num("anios", "Años de antigüedad máxima")}{refSel(b.referencia, "referencia", "Se mide")}</>)}
          {b.tipo === "unidad_capacidad_min" && (<>
            {num("asientos", "Asientos mínimos")}
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Solo para el uso / ruta</span>
              <input className={`${INPUT} ${sel}`} value={b.uso} maxLength={200} disabled={soloLectura} placeholder="Vacío = todas las unidades" onChange={(e) => cambiar({ uso: e.target.value })} />
            </label>
          </>)}
          {b.tipo === "unidad_doc" && (<>
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Documento de cada unidad</span>
              <select className={`${INPUT} ${sel}`} value={b.doc} disabled={soloLectura} onChange={(e) => cambiar({ doc: e.target.value })}>
                <option value="">— elige</option>
                {DOCS_UNIDAD_LIC.map((d) => <option key={d} value={d}>{ETIQUETA_DOC_UNIDAD[d]}</option>)}
              </select>
            </label>
            {refSel(b.vigenteAl, "vigenteAl", "Vigente")}
          </>)}
          {(b.tipo === "unidades_titulares_min" || b.tipo === "unidades_reten_min" || b.tipo === "conductores_relevo_min" || b.tipo === "experiencia_cartas_min") &&
            num("n", b.tipo === "experiencia_cartas_min" ? "Cartas mínimas" : "Cantidad mínima")}
          {b.tipo === "conductor_licencia" && (
            <fieldset className="sm:col-span-2">
              <legend className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Categorías aceptadas (vale cualquiera que las cubra)</legend>
              <div className="flex flex-wrap gap-2">
                {CATEGORIAS_CLASE_A.map((c) => (
                  <label key={c} className="flex items-center gap-1 text-xs border rounded-lg px-2 py-1">
                    <input type="checkbox" checked={b.categorias.includes(c)} disabled={soloLectura}
                      onChange={() => cambiar({ categorias: b.categorias.includes(c) ? b.categorias.filter((x) => x !== c) : [...b.categorias, c] })} />
                    {c}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {b.tipo === "conductor_doc" && (<>
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Documento de cada conductor</span>
              <select className={`${INPUT} ${sel}`} value={b.doc} disabled={soloLectura}
                onChange={(e) => {
                  const nuevo = e.target.value;
                  const sug = (DOCS_CONDUCTOR_REGLA as readonly string[]).includes(nuevo) ? tipoDocConductor(nuevo as (typeof DOCS_CONDUCTOR_REGLA)[number]).antiguedadSugeridaDias : null;
                  cambiar({ doc: nuevo, antig: !b.antig.trim() && sug != null ? String(sug) : b.antig });
                }}>
                <option value="">— elige</option>
                {DOCS_CONDUCTOR_REGLA.map((d) => <option key={d} value={d}>{tipoDocConductor(d).etiqueta}</option>)}
              </select>
            </label>
            {num("antig", "Antigüedad máxima (días)", "Vacío = sin tope.")}
          </>)}
          {b.tipo === "experiencia_anios_min" && (<>
            {num("anios", "Años mínimos")}
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Contados desde</span>
              <select className={`${INPUT} ${sel}`} value={b.desde} disabled={soloLectura} onChange={(e) => cambiar({ desde: e.target.value as Borrador["desde"] })}>
                <option value="primer_contrato">el primer contrato</option>
                <option value="constitucion">la constitución de la empresa</option>
              </select>
            </label>
          </>)}
          {b.tipo === "experiencia_monto_min" && (<>
            {num("monto", "Monto mínimo", "Sin símbolo: 150000 o 150,000.00.")}
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Moneda</span>
              <select className={`${INPUT} ${sel}`} value={b.moneda} disabled={soloLectura} onChange={(e) => cambiar({ moneda: e.target.value as Moneda })}>
                <option value="PEN">Soles (S/)</option>
                <option value="USD">Dólares (US$)</option>
              </select>
            </label>
          </>)}
          {b.tipo === "experiencia_ventana_anios" && num("anios", "Últimos N años")}
          {b.tipo === "seguro" && (<>
            <label className="block min-w-0">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Póliza</span>
              <select className={`${INPUT} ${sel}`} value={b.seguro} disabled={soloLectura} onChange={(e) => cambiar({ seguro: e.target.value })}>
                <option value="">— elige</option>
                {TIPOS_SEGURO_LIC.map((s) => <option key={s} value={s}>{ETIQUETA_SEGURO_LIC[s]}</option>)}
              </select>
            </label>
            {refSel(b.vigenteAl, "vigenteAl", "Vigente")}
          </>)}
        </div>
      )}

      {b.tipo && (lectura.regla
        ? <p className="text-[11px] text-gray-600">El ERP comprueba: <b>{describirRegla(lectura.regla)}</b>.</p>
        : <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
            Regla incompleta: {lectura.falta}. Hasta completarla, el requisito se guarda <b>sin regla</b> (lo marca una persona).
          </p>)}
    </div>
  );
}
