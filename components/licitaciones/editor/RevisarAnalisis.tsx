"use client";
// components/licitaciones/editor/RevisarAnalisis.tsx — LA IA PROPONE, LA PERSONA DECIDE (D6). Nada del
// análisis entra al doc sin un clic:
//  (a) datos del concurso: «actual · leído en las bases», casilla por campo, desmarcadas;
//  (b) requisitos: casilla por propuesto (marcados de entrada los OBLIGATORIOS nuevos); «Agregar» los
//      convierte con requisitoDePropuesto sin duplicar los ya aceptados de ESTE análisis
//      (doc.analisis.aceptados con la clave del propuesto; `aplicadoId` = el análisis);
//  (c) consultas absueltas → doc.consultas, con «cómo la incorpora el postor» vacío;
//  (d) estructura → bloques del Expediente (bloquesDeEstructura), con confirm si ya hay bloques;
//  (e) penalidades, criterios y advertencias: solo lectura; (f) los avisos de la normalización.
// Las claves del análisis (req-1, con-1, est-1…) son de CADA análisis: cuando se aplica uno nuevo, la
// lista de aceptados/descartados del anterior se reemplaza (contrato: un solo `aplicadoId`).
import { useMemo, useState } from "react";
import { bloquesDeEstructura, requisitoDePropuesto } from "@/lib/licitaciones/analisis";
import { describirRegla } from "@/lib/licitaciones/reglas";
import { fechaDMY } from "@/lib/licitaciones/util";
import {
  TOPES_DOC,
  type AnalisisBases, type CitaBases, type DocLicitacion, type Licitacion, type Paso, type RequisitoPropuesto,
} from "@/lib/licitaciones/tipos";
import type { ColumnasLic, TonoAviso } from "./contrato-editor";
import type { ResultadoIA } from "./analisis-ia";
import { ETIQUETA_CATEGORIA, instanteLima } from "./etiquetas";
import { BOTON, BOTON_PRIMARIO, Chip, Tarjeta, claveTexto } from "./bases/ui";

type Props = {
  r: ResultadoIA;
  lic: Licitacion;
  doc: DocLicitacion;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  cambiarColumnas: (c: ColumnasLic) => void;
  nuevoId: () => string;
  soloLectura: boolean;
  aviso: (t: string, tono?: TonoAviso) => void;
  irA: (p: Paso, ancla?: string | null) => void;
  onCerrar: () => void;
  onAplicado: () => void;
};

type CampoConcurso = keyof AnalisisBases["concurso"];
const CAMPOS: { k: CampoConcurso; rot: string; fmt?: (v: string | number) => string }[] = [
  { k: "cliente_nombre", rot: "Entidad que convoca" },
  { k: "codigo", rot: "Código del concurso" },
  { k: "objeto", rot: "Objeto" },
  { k: "atencion", rot: "Atención" },
  { k: "fecha_consultas", rot: "Fecha de consultas", fmt: (v) => fechaDMY(String(v)) },
  { k: "fecha_presentacion", rot: "Fecha de presentación", fmt: (v) => fechaDMY(String(v)) },
  { k: "hora_presentacion", rot: "Hora de presentación" },
  { k: "fecha_inicio_servicio", rot: "Inicio del servicio", fmt: (v) => fechaDMY(String(v)) },
  { k: "plazo_meses", rot: "Plazo", fmt: (v) => `${v} meses` },
];

type EstadoPropuesto = "nuevo" | "duplicado" | "agregado" | "agregado_quitado" | "descartado";
const uniq = (xs: string[]) => [...new Set(xs)];

export default function RevisarAnalisis({ r, lic, doc, cambiarDoc, cambiarColumnas, nuevoId, soloLectura, aviso, irA, onCerrar, onAplicado }: Props) {
  const a = r.resultado;
  const mismo = doc.analisis.aplicadoId === r.analisisId;
  const aceptados = useMemo(() => new Set(mismo ? doc.analisis.aceptados : []), [mismo, doc.analisis.aceptados]);
  const descartados = useMemo(() => new Set(mismo ? doc.analisis.descartados : []), [mismo, doc.analisis.descartados]);

  // Nombres de los archivos citados: etiqueta del envío (A1…) + nombre del archivo en las bases.
  const nombres = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of r.archivos) {
      const b = doc.bases.find((y) => y.id === x.id);
      m.set(x.id, `${x.etiqueta}${b ? ` · ${b.nombre}` : " · (ya no está en las bases)"}`);
    }
    return m;
  }, [r.archivos, doc.bases]);

  // ── (a) Datos del concurso ──
  const filasDatos = CAMPOS.map((c) => {
    const leido = a.concurso[c.k];
    const actual = lic[c.k] as string | number | null;
    const igual = leido != null && String(actual ?? "").trim() === String(leido).trim();
    return { ...c, leido, actual, igual };
  }).filter((f) => f.leido != null);
  const [marcDatos, setMarcDatos] = useState<Set<CampoConcurso>>(new Set());
  const aplicarDatos = () => {
    const elegidas = filasDatos.filter((f) => marcDatos.has(f.k) && !f.igual);
    if (!elegidas.length) return;
    const patch: Record<string, unknown> = {};
    for (const f of elegidas) patch[f.k] = f.leido;
    const desvincula = !!patch.cliente_nombre && lic.cliente_id != null;
    if (desvincula) patch.cliente_id = null;
    const lista = elegidas.map((f) => `• ${f.rot}: ${f.actual == null || f.actual === "" ? "(vacío)" : f.fmt ? f.fmt(f.actual) : f.actual} → ${f.fmt ? f.fmt(f.leido!) : f.leido}`).join("\n");
    if (!window.confirm(`Aplicar a la licitación lo leído en las bases:\n\n${lista}${desvincula ? "\n\nAl cambiar el nombre de quien convoca, la licitación deja de estar vinculada al cliente del ERP (lo puedes volver a elegir)." : ""}\n\n¿Aplicar?`)) return;
    cambiarColumnas(patch as ColumnasLic);
    setMarcDatos(new Set());
    onAplicado();
    aviso(`Se aplicaron ${elegidas.length} dato(s) del concurso.`);
  };

  // ── (b) Requisitos ──
  const textosReq = useMemo(() => new Set(doc.requisitos.map((q) => claveTexto(q.texto))), [doc.requisitos]);
  const estadoReq = (p: RequisitoPropuesto): EstadoPropuesto => {
    const existe = textosReq.has(claveTexto(p.texto));
    if (aceptados.has(p.clave)) return existe ? "agregado" : "agregado_quitado";
    if (descartados.has(p.clave)) return "descartado";
    return existe ? "duplicado" : "nuevo";
  };
  const [marcReq, setMarcReq] = useState<Set<string> | null>(null);
  const porDefectoReq = useMemo(() => new Set(a.requisitos.filter((p) => p.obligatorio && estadoReq(p) === "nuevo").map((p) => p.clave)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.requisitos]);
  const marcadosReq = marcReq ?? porDefectoReq;
  const [verDescartados, setVerDescartados] = useState(false);
  const elegiblesReq = a.requisitos.filter((p) => marcadosReq.has(p.clave) && estadoReq(p) !== "agregado" && estadoReq(p) !== "descartado");

  const conAnalisis = (d: DocLicitacion, f: (an: DocLicitacion["analisis"]) => DocLicitacion["analisis"]): DocLicitacion => {
    const an = d.analisis.aplicadoId === r.analisisId ? d.analisis : { aplicadoId: r.analisisId, aceptados: [], descartados: [] };
    return { ...d, analisis: f(an) };
  };

  const agregarReq = () => {
    if (!elegiblesReq.length) return;
    const caben = Math.max(0, TOPES_DOC.maxRequisitos - doc.requisitos.length);
    const van = elegiblesReq.slice(0, caben);
    if (!van.length) { aviso(`La lista ya tiene ${TOPES_DOC.maxRequisitos} requisitos (el tope): quita alguno para agregar más.`, "error"); return; }
    const claves = van.map((p) => p.clave);
    cambiarDoc((d) => conAnalisis({ ...d, requisitos: [...d.requisitos, ...van.map((p) => requisitoDePropuesto(p, nuevoId))] }, (an) => ({
      aplicadoId: r.analisisId, aceptados: uniq([...an.aceptados, ...claves]), descartados: an.descartados.filter((c) => !claves.includes(c)),
    })));
    setMarcReq(new Set([...marcadosReq].filter((c) => !claves.includes(c))));
    onAplicado();
    aviso(`Se agregaron ${van.length} requisito(s) a la lista.${elegiblesReq.length > van.length ? ` ${elegiblesReq.length - van.length} no cupieron (tope de ${TOPES_DOC.maxRequisitos}).` : ""}`, elegiblesReq.length > van.length ? "aviso" : "ok");
  };
  const descartarReq = (clave: string, si: boolean) => cambiarDoc((d) => conAnalisis(d, (an) => ({
    aplicadoId: r.analisisId, aceptados: an.aceptados,
    descartados: si ? uniq([...an.descartados, clave]) : an.descartados.filter((c) => c !== clave),
  })));
  const alternarReq = (clave: string) => {
    const s = new Set(marcadosReq);
    if (s.has(clave)) s.delete(clave); else s.add(clave);
    setMarcReq(s);
  };

  // ── (c) Consultas ──
  const preguntas = useMemo(() => new Set(doc.consultas.map((c) => claveTexto(c.pregunta))), [doc.consultas]);
  const estadoCon = (clave: string, pregunta: string): EstadoPropuesto => {
    const existe = preguntas.has(claveTexto(pregunta));
    if (aceptados.has(clave)) return existe ? "agregado" : "agregado_quitado";
    return existe ? "duplicado" : "nuevo";
  };
  const [marcCon, setMarcCon] = useState<Set<string> | null>(null);
  const porDefectoCon = useMemo(() => new Set(a.consultas.filter((c) => estadoCon(c.clave, c.pregunta) === "nuevo").map((c) => c.clave)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.consultas]);
  const marcadosCon = marcCon ?? porDefectoCon;
  const elegiblesCon = a.consultas.filter((c) => marcadosCon.has(c.clave) && estadoCon(c.clave, c.pregunta) !== "agregado");
  const agregarCon = () => {
    if (!elegiblesCon.length) return;
    const claves = elegiblesCon.map((c) => c.clave);
    cambiarDoc((d) => conAnalisis({
      ...d,
      consultas: [...d.consultas, ...elegiblesCon.map((c) => ({
        id: nuevoId(), numero: c.numero, pregunta: c.pregunta, respuesta: c.respuesta, incorporacion: "",
        cita: { archivoId: c.cita.archivoId, pagina: c.cita.pagina, texto: c.cita.texto },
      }))],
    }, (an) => ({ aplicadoId: r.analisisId, aceptados: uniq([...an.aceptados, ...claves]), descartados: an.descartados })));
    setMarcCon(new Set());
    onAplicado();
    aviso(`Se agregaron ${claves.length} consulta(s) absuelta(s). Completa en cada una cómo la incorpora la propuesta.`);
  };

  // ── (d) Estructura ──
  const clavesEst = a.estructura.map((e) => e.clave);
  const estructuraUsada = clavesEst.length > 0 && clavesEst.every((c) => aceptados.has(c));
  const usarEstructura = () => {
    const ya = doc.expediente.bloques.length;
    const caben = Math.max(0, TOPES_DOC.maxBloquesExpediente - ya);
    if (!caben) { aviso(`El expediente ya tiene ${TOPES_DOC.maxBloquesExpediente} bloques (el tope): quita alguno primero.`, "error"); return; }
    const van = Math.min(caben, a.estructura.length);
    const texto = ya
      ? `El Expediente ya tiene ${ya} bloque(s). Se AGREGAN ${van} bloque(s) al final (no se borra ni se reemplaza nada)${van < a.estructura.length ? `; ${a.estructura.length - van} no caben por el tope de ${TOPES_DOC.maxBloquesExpediente}` : ""}.\n\nCada documento de la lista queda como «adjunto pendiente»: en el Expediente le eliges de dónde sale.\n\n¿Agregar?`
      : `Se crean ${van} bloque(s) en el Expediente con los títulos y la lista de documentos que piden las bases. Cada documento queda como «adjunto pendiente»: en el Expediente le eliges de dónde sale.\n\n¿Crear?`;
    if (!window.confirm(texto)) return;
    cambiarDoc((d) => conAnalisis({
      ...d,
      expediente: { ...d.expediente, bloques: [...d.expediente.bloques, ...bloquesDeEstructura(a.estructura, nuevoId).slice(0, caben)] },
    }, (an) => ({ aplicadoId: r.analisisId, aceptados: uniq([...an.aceptados, ...clavesEst]), descartados: an.descartados })));
    onAplicado();
    aviso(`Se agregaron ${van} bloque(s) al Expediente.`);
  };

  const pendientesAplicar = elegiblesReq.length + elegiblesCon.length + (estructuraUsada ? 0 : a.estructura.length ? 1 : 0);
  const cerrar = () => {
    if (pendientesAplicar > 0 && !window.confirm("Hay puntos del análisis que no se aplicaron. Si cierras, el resultado se pierde (no queda en la pantalla) y para verlo de nuevo hay que volver a leer las bases, que se cobra otra vez.\n\n¿Cerrar el análisis?")) return;
    onCerrar();
  };

  const visiblesReq = a.requisitos.filter((p) => verDescartados || estadoReq(p) !== "descartado");
  const nDescartados = a.requisitos.filter((p) => estadoReq(p) === "descartado").length;
  const editable = !soloLectura;

  return (
    <Tarjeta id="analisis" titulo={`🔎 Revisar el análisis de la IA (N° ${r.analisisId})`}
      subtitulo={<>Leído {instanteLima(r.en)} · {r.archivos.length} archivo(s){r.conTexto ? " + texto pegado" : ""} · {r.uso.tokensEntrada.toLocaleString("es-PE")} tokens de entrada, {r.uso.tokensSalida.toLocaleString("es-PE")} de salida{r.uso.costoUsd != null ? ` · US$ ${r.uso.costoUsd.toFixed(2)}` : ""}. <b>La IA propone; tú decides qué entra.</b> El resultado vive solo en esta pantalla: si la cierras sin aplicarlo, tendrás que volver a leer las bases.</>}
      acciones={<button type="button" className={BOTON} onClick={cerrar}>Cerrar el análisis</button>}>

      {r.avisos.length > 0 && (
        <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <summary className="font-bold cursor-pointer">{r.avisos.length} aviso(s) al leer la respuesta (reglas que no calzaron, fechas inválidas…)</summary>
          <ul className="mt-1 space-y-0.5 list-disc pl-4">{r.avisos.map((x, i) => <li key={i}>{x.detalle}</li>)}</ul>
        </details>
      )}

      {/* (a) Datos del concurso */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Datos del concurso</h3>
        {filasDatos.length === 0 ? <p className="text-xs text-gray-500">La IA no encontró datos del concurso en lo que leyó.</p> : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr><th className="p-2 w-8"></th><th className="p-2 text-left">Campo</th><th className="p-2 text-left">Actual</th><th className="p-2 text-left">Leído en las bases</th></tr>
              </thead>
              <tbody className="divide-y">
                {filasDatos.map((f) => (
                  <tr key={f.k} className={f.igual ? "text-gray-400" : ""}>
                    <td className="p-2 align-top">
                      {f.igual ? <span title="Ya coincide">✓</span> : (
                        <input type="checkbox" aria-label={`Aplicar ${f.rot}`} disabled={!editable} checked={marcDatos.has(f.k)}
                          onChange={() => { const s = new Set(marcDatos); if (s.has(f.k)) s.delete(f.k); else s.add(f.k); setMarcDatos(s); }} />
                      )}
                    </td>
                    <td className="p-2 align-top font-bold whitespace-nowrap">{f.rot}</td>
                    <td className="p-2 align-top break-words">{f.actual == null || f.actual === "" ? <span className="text-gray-400">(vacío)</span> : f.fmt ? f.fmt(f.actual) : String(f.actual)}</td>
                    <td className="p-2 align-top break-words">{f.fmt ? f.fmt(f.leido!) : String(f.leido)}{f.igual && " (igual)"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filasDatos.some((f) => !f.igual) && editable && (
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={BOTON_PRIMARIO} disabled={!filasDatos.some((f) => marcDatos.has(f.k) && !f.igual)} onClick={aplicarDatos}>Aplicar los datos marcados</button>
            {!filasDatos.some((f) => marcDatos.has(f.k) && !f.igual) && <span className="text-[11px] text-gray-500">Marca los campos que quieres cambiar: ninguno se aplica solo.</span>}
          </div>
        )}
      </div>

      {/* (b) Requisitos */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Requisitos propuestos ({a.requisitos.length})</h3>
          {editable && a.requisitos.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              <button type="button" className={BOTON} onClick={() => setMarcReq(new Set(a.requisitos.filter((p) => ["nuevo", "agregado_quitado"].includes(estadoReq(p))).map((p) => p.clave)))}>Marcar todos los nuevos</button>
              <button type="button" className={BOTON} onClick={() => setMarcReq(new Set(a.requisitos.filter((p) => p.obligatorio && estadoReq(p) === "nuevo").map((p) => p.clave)))}>Solo obligatorios</button>
              <button type="button" className={BOTON} onClick={() => setMarcReq(new Set())}>Ninguno</button>
            </div>
          )}
        </div>
        {a.requisitos.length === 0 ? <p className="text-xs text-gray-500">La IA no encontró requisitos en lo que leyó. Escríbelos a mano en la lista de abajo.</p> : (
          <ul className="space-y-1.5">
            {visiblesReq.map((p) => {
              const e = estadoReq(p);
              const marcado = marcadosReq.has(p.clave);
              const bloqueado = e === "agregado" || e === "descartado";
              return (
                <li key={p.clave} className={`rounded-xl border px-3 py-2 text-xs ${e === "agregado" ? "bg-emerald-50 border-emerald-200" : e === "descartado" ? "bg-gray-50 border-gray-200 text-gray-400" : "bg-white"}`}>
                  <div className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5" aria-label="Agregar este requisito" disabled={!editable || bloqueado} checked={e === "agregado" || (marcado && !bloqueado)} onChange={() => alternarReq(p.clave)} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {p.numeral && <span className="font-bold text-gray-700">{p.numeral}</span>}
                        <Chip texto={ETIQUETA_CATEGORIA[p.categoria]} color="#0b315f" bg="#e0e7ef" />
                        {p.obligatorio ? <Chip texto="Obligatorio" color="#991b1b" bg="#fee2e2" /> : <Chip texto="Deseable / puntaje" color="#4b5563" bg="#f3f4f6" />}
                        {e === "agregado" && <Chip texto="✓ ya agregado" color="#166534" bg="#dcfce7" />}
                        {e === "agregado_quitado" && <Chip texto="agregado antes y luego quitado" color="#92400e" bg="#fef3c7" />}
                        {e === "duplicado" && <Chip texto="ya hay uno igual en la lista" color="#92400e" bg="#fef3c7" />}
                        {e === "descartado" && <Chip texto="descartado" color="#6b7280" bg="#f3f4f6" />}
                      </div>
                      <p className="text-gray-900 whitespace-pre-wrap">{p.texto}</p>
                      <p className="text-gray-600">{p.regla ? <>⚙ El ERP comprobaría: <b>{describirRegla(p.regla)}</b></> : "Sin regla: lo marcará una persona."}</p>
                      <TextoCita cita={p.cita} nombres={nombres} />
                    </div>
                    {editable && e !== "agregado" && (
                      <button type="button" className="text-[11px] font-bold text-gray-500 underline shrink-0" onClick={() => descartarReq(p.clave, e !== "descartado")}>
                        {e === "descartado" ? "Restaurar" : "Descartar"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {nDescartados > 0 && (
          <button type="button" className="text-[11px] font-bold text-gray-500 underline" onClick={() => setVerDescartados((v) => !v)}>
            {verDescartados ? "Ocultar" : "Ver"} {nDescartados} descartado(s)
          </button>
        )}
        {editable && a.requisitos.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={BOTON_PRIMARIO} disabled={!elegiblesReq.length} onClick={agregarReq}>Agregar {elegiblesReq.length || ""} marcado(s) a la lista de requisitos</button>
            {!elegiblesReq.length && <span className="text-[11px] text-gray-500">Marca los requisitos que quieres agregar.</span>}
            <button type="button" className={BOTON} onClick={() => irA("bases", "requisitos")}>Ver la lista ↓</button>
          </div>
        )}
      </div>

      {/* (c) Consultas absueltas */}
      {a.consultas.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Consultas absueltas ({a.consultas.length})</h3>
          <ul className="space-y-1.5">
            {a.consultas.map((c) => {
              const e = estadoCon(c.clave, c.pregunta);
              return (
                <li key={c.clave} className={`rounded-xl border px-3 py-2 text-xs ${e === "agregado" ? "bg-emerald-50 border-emerald-200" : "bg-white"}`}>
                  <div className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5" aria-label="Agregar esta consulta" disabled={!editable || e === "agregado"} checked={e === "agregado" || marcadosCon.has(c.clave)}
                      onChange={() => { const s = new Set(marcadosCon); if (s.has(c.clave)) s.delete(c.clave); else s.add(c.clave); setMarcCon(s); }} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-bold text-gray-800">
                        {c.numero ? `${c.numero} · ` : ""}{c.pregunta}
                        {e === "agregado" && <span className="ml-1"><Chip texto="✓ ya agregada" color="#166534" bg="#dcfce7" /></span>}
                        {e === "duplicado" && <span className="ml-1"><Chip texto="ya hay una igual" color="#92400e" bg="#fef3c7" /></span>}
                      </p>
                      <p className="text-gray-700 whitespace-pre-wrap">↳ {c.respuesta || <span className="text-gray-400">(sin respuesta)</span>}</p>
                      <TextoCita cita={c.cita} nombres={nombres} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {editable && (
            <button type="button" className={BOTON_PRIMARIO} disabled={!elegiblesCon.length} onClick={agregarCon}>Agregar {elegiblesCon.length || ""} marcada(s) a «Consultas absueltas»</button>
          )}
        </div>
      )}

      {/* (d) Estructura de presentación */}
      {a.estructura.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Estructura de presentación ({a.estructura.length} bloque(s))</h3>
          <ol className="space-y-1.5">
            {a.estructura.map((e) => (
              <li key={e.clave} className="rounded-xl border px-3 py-2 text-xs bg-white">
                <p className="font-bold text-gray-800">{e.titulo || "(sin título)"}{e.subtitulo ? ` · ${e.subtitulo}` : ""}{e.referencia && <span className="font-normal text-gray-500"> · {e.referencia}</span>}</p>
                {e.contenido.length > 0 && <ul className="list-disc pl-4 text-gray-700 mt-0.5">{e.contenido.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              </li>
            ))}
          </ol>
          {editable && (
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" className={BOTON_PRIMARIO} disabled={estructuraUsada} onClick={usarEstructura}>Usar esta estructura en el Expediente</button>
              {estructuraUsada && <span className="text-[11px] text-gray-500">Ya se agregó al Expediente.</span>}
              <button type="button" className={BOTON} onClick={() => irA("expediente", "expediente")}>Ir al Expediente →</button>
            </div>
          )}
        </div>
      )}

      {/* (e) Para tener presente */}
      {(a.penalidades.length > 0 || a.criterios.length > 0 || a.advertencias.length > 0) && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Para tener presente (no se guarda)</h3>
          <p className="text-[11px] text-gray-500">Solo informativo. Si alguno es un requisito, agrégalo a mano en la lista de abajo.</p>
          {a.advertencias.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-bold">Advertencias de la IA</p>
              <ul className="list-disc pl-4 mt-0.5 space-y-0.5">{a.advertencias.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {a.criterios.length > 0 && (
            <details className="rounded-xl border px-3 py-2 text-xs">
              <summary className="font-bold cursor-pointer text-gray-800">Criterios de evaluación ({a.criterios.length})</summary>
              <ul className="mt-1 space-y-1">{a.criterios.map((c) => <li key={c.clave}><span className="text-gray-800">{c.texto}</span>{c.peso && <b> · {c.peso}</b>}<TextoCita cita={c.cita} nombres={nombres} /></li>)}</ul>
            </details>
          )}
          {a.penalidades.length > 0 && (
            <details className="rounded-xl border px-3 py-2 text-xs">
              <summary className="font-bold cursor-pointer text-gray-800">Penalidades ({a.penalidades.length})</summary>
              <ul className="mt-1 space-y-1">{a.penalidades.map((c) => <li key={c.clave}><span className="text-gray-800">{c.texto}</span><TextoCita cita={c.cita} nombres={nombres} /></li>)}</ul>
            </details>
          )}
        </div>
      )}
    </Tarjeta>
  );
}

/** «A1 · Bases.pdf · pág. 12 · "cita"»; del texto pegado si no hay archivo. */
export function TextoCita({ cita, nombres }: { cita: CitaBases | null; nombres: Map<string, string> }) {
  if (!cita || (!cita.archivoId && !cita.texto && !cita.pagina)) return null;
  const archivo = cita.archivoId ? nombres.get(cita.archivoId) ?? "un archivo que ya no está en las bases" : cita.texto ? "texto pegado" : null;
  return (
    <p className="text-[11px] text-gray-500 break-words">
      📎 {archivo}{cita.pagina ? ` · pág. ${cita.pagina}` : ""}{cita.texto ? <> · <i>«{cita.texto}»</i></> : ""}
    </p>
  );
}
