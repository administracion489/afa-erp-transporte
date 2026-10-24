"use client";
// components/licitaciones/TabExperiencia.tsx — Pestaña «Experiencia» de /licitaciones.
//
// El catálogo de contratos que la empresa acredita (experiencia_empresa). Cada licitación elige de
// aquí cuáles presenta y arma su cuadro. Reglas de la pantalla:
//  · Se valida con validarExperiencia (lib/licitaciones/datos.ts) MIENTRAS se escribe: el botón de
//    guardar se apaga y debajo dice qué le falta, con el mismo texto que daría la base.
//  · Un importe vacío es null, nunca S/ 0.00; los totales van POR MONEDA (soles y dólares no se suman).
//  · Lo que el ERP sabe del cliente (sugerenciaReservas) es INFORMATIVO: se enseña al lado y solo pasa
//    al formulario lo que la persona marca y confirma. Nunca se rellena solo.
//  · Desactivar no borra: las licitaciones guardan los ids de su experiencia.

import { useCallback, useEffect, useMemo, useState } from "react";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import {
  desactivarExperiencia, guardarExperiencia, leerExperiencia, reactivarExperiencia, subirArchivo, sugerenciaReservas,
  validarExperiencia, type EntradaExperiencia, type FalloDatos, type SugerenciaReservas,
} from "@/lib/licitaciones/datos";
import { fechaDMY, fmtImporte } from "@/lib/licitaciones/util";
import { mimeDeNombre } from "@/lib/licitaciones/archivos";
import type { ArchivoRef, Experiencia, FechaISO, MimeArchivo, Moneda, SustentoTipo } from "@/lib/licitaciones/tipos";
import { fechaLima } from "@/lib/documentos-estado";
import { rotuloCliente, type ClienteBuscable } from "@/lib/clientes-buscador";
import CampoClienteErp from "./CampoClienteErp";
import { ACCEPT_UNIBLE, fmtBytes, leerImporte, SUSTENTO_ETIQUETA, SUSTENTOS } from "./etiquetas";
import {
  AvisoFallo, AZUL, Cargando, Chip, claseBotonChico, claseBotonPrimario, claseBotonSecundario, claseCampo, claseEtiqueta,
  ErrorFijo, Modal, useAviso,
} from "./ui";

type Lectura = { estado: "cargando" } | { estado: "fallo"; fallo: FalloDatos } | { estado: "ok"; filas: Experiencia[] };

const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MIMES_SUSTENTO: readonly MimeArchivo[] = ["application/pdf", "image/png", "image/jpeg"];

/** Mismo orden que leerExperiencia: el contrato más reciente primero, id de desempate. */
const ordenar = (xs: Experiencia[]) => [...xs].sort((a, b) => (a.inicio !== b.inicio ? (a.inicio < b.inicio ? 1 : -1) : b.id - a.id));

type Form = {
  id: number | null; cliente_id: number | null; cliente_nombre: string; cliente_ruc: string;
  contacto_nombre: string; contacto_cargo: string; contacto_telefono: string; contacto_email: string;
  objeto: string; sector: string; zona: string; inicio: string; fin: string; vigente: boolean;
  sustento_tipo: SustentoTipo | ""; sustento_ref: string; sustento_fecha: string;
  importe: string; moneda: Moneda; igv: "" | "si" | "no"; sustentos: ArchivoRef[]; notas: string;
};
const FORM_VACIO: Form = {
  id: null, cliente_id: null, cliente_nombre: "", cliente_ruc: "", contacto_nombre: "", contacto_cargo: "", contacto_telefono: "",
  contacto_email: "", objeto: "Transporte de personal", sector: "", zona: "", inicio: "", fin: "", vigente: false,
  sustento_tipo: "", sustento_ref: "", sustento_fecha: "", importe: "", moneda: "PEN", igv: "", sustentos: [], notas: "",
};
function formDe(e: Experiencia): Form {
  return {
    id: e.id, cliente_id: e.cliente_id, cliente_nombre: e.cliente_nombre, cliente_ruc: e.cliente_ruc ?? "",
    contacto_nombre: e.contacto_nombre ?? "", contacto_cargo: e.contacto_cargo ?? "", contacto_telefono: e.contacto_telefono ?? "",
    contacto_email: e.contacto_email ?? "", objeto: e.objeto, sector: e.sector ?? "", zona: e.zona ?? "", inicio: e.inicio, fin: e.fin ?? "",
    vigente: e.vigente, sustento_tipo: e.sustento_tipo ?? "", sustento_ref: e.sustento_ref ?? "", sustento_fecha: e.sustento_fecha ?? "",
    importe: e.importe != null ? e.importe.toFixed(2) : "", moneda: e.moneda,
    igv: e.importe_incluye_igv == null ? "" : e.importe_incluye_igv ? "si" : "no", sustentos: [...e.sustentos], notas: e.notas ?? "",
  };
}
function entradaDe(f: Form): EntradaExperiencia {
  const nulo = (s: string) => (s.trim() ? s.trim() : null);
  return {
    ...(f.id != null ? { id: f.id } : {}),
    cliente_id: f.cliente_id, cliente_nombre: f.cliente_nombre, cliente_ruc: nulo(f.cliente_ruc),
    contacto_nombre: nulo(f.contacto_nombre), contacto_cargo: nulo(f.contacto_cargo), contacto_telefono: nulo(f.contacto_telefono),
    contacto_email: nulo(f.contacto_email), objeto: f.objeto, sector: nulo(f.sector), zona: nulo(f.zona),
    inicio: f.inicio as FechaISO, fin: f.vigente ? null : (f.fin || null), vigente: f.vigente,
    sustento_tipo: f.sustento_tipo || null, sustento_ref: nulo(f.sustento_ref), sustento_fecha: f.sustento_fecha || null,
    importe: leerImporte(f.importe), moneda: f.moneda, importe_incluye_igv: f.igv === "" ? null : f.igv === "si",
    sustentos: f.sustentos, notas: nulo(f.notas),
  };
}

function periodo(e: Experiencia): string {
  return `${fechaDMY(e.inicio)} → ${e.vigente ? "vigente" : e.fin ? fechaDMY(e.fin) : "sin fecha de fin"}`;
}

export default function TabExperiencia() {
  const { mostrar, nodo: nodoAviso } = useAviso();
  const [verInactivas, setVerInactivas] = useState(false);
  const [lectura, setLectura] = useState<Lectura>({ estado: "cargando" });
  const [intento, setIntento] = useState(0);
  const [texto, setTexto] = useState("");
  const [editando, setEditando] = useState<Form | null>(null);
  const [cambiando, setCambiando] = useState<number | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    leerExperiencia({ incluirInactivas: verInactivas }).then((r) => {
      if (vivo) setLectura(r.ok ? { estado: "ok", filas: r.filas } : { estado: "fallo", fallo: r });
    }).catch((e: unknown) => {
      if (vivo) setLectura({ estado: "fallo", fallo: { ok: false, error: `No se pudo leer la experiencia (${mensaje(e)}).` } });
    });
    return () => { vivo = false; };
  }, [verInactivas, intento]);

  const recargar = useCallback(() => { setLectura({ estado: "cargando" }); setIntento((n) => n + 1); }, []);
  const filas = useMemo(() => (lectura.estado === "ok" ? lectura.filas : []), [lectura]);
  const filtradas = useMemo(() => {
    const q = norm(texto);
    if (!q) return filas;
    return filas.filter((e) => norm(`${e.cliente_nombre} ${e.cliente_ruc ?? ""} ${e.objeto} ${e.sector ?? ""} ${e.zona ?? ""} ${e.sustento_ref ?? ""} ${e.contacto_nombre ?? ""}`).includes(q));
  }, [filas, texto]);

  /** Totales de las ACTIVAS en pantalla, por moneda. Las que no tienen importe se cuentan aparte. */
  const totales = useMemo(() => {
    const activas = filtradas.filter((e) => e.activo);
    const por = new Map<Moneda, { importe: number; n: number }>();
    let sinImporte = 0, conIgv = 0, sinIgv = 0, igvSinDeclarar = 0, sinSustento = 0;
    for (const e of activas) {
      if (!e.sustentos.length) sinSustento++;
      if (e.importe == null) { sinImporte++; continue; }
      const t = por.get(e.moneda) ?? { importe: 0, n: 0 };
      por.set(e.moneda, { importe: Math.round((t.importe + e.importe) * 100) / 100, n: t.n + 1 });
      if (e.importe_incluye_igv === true) conIgv++; else if (e.importe_incluye_igv === false) sinIgv++; else igvSinDeclarar++;
    }
    return { activas: activas.length, por: (["PEN", "USD"] as Moneda[]).filter((m) => por.has(m)).map((m) => ({ moneda: m, ...por.get(m)! })), sinImporte, conIgv, sinIgv, igvSinDeclarar, sinSustento };
  }, [filtradas]);

  async function alternarActivo(e: Experiencia) {
    const ok = window.confirm(e.activo
      ? `¿Desactivar la experiencia con «${e.cliente_nombre}» (${periodo(e)})?\n\nNo se borra: sale del catálogo para elegir en licitaciones nuevas. Las licitaciones que ya la tienen la siguen viendo, y su revisión lo dice.`
      : `¿Reactivar la experiencia con «${e.cliente_nombre}» (${periodo(e)})?\n\nVuelve al catálogo para elegir en las licitaciones.`);
    if (!ok) return;
    setCambiando(e.id);
    setErrorAccion(null);
    const r = await (e.activo ? desactivarExperiencia(e.id) : reactivarExperiencia(e.id));
    setCambiando(null);
    if (!r.ok) { setErrorAccion(r.error); return; }
    setLectura((l) => {
      if (l.estado !== "ok") return l;
      const resto = l.filas.filter((x) => x.id !== e.id);
      return { ...l, filas: !r.fila.activo && !verInactivas ? resto : ordenar([...resto, r.fila]) };
    });
    mostrar(r.fila.activo ? `«${e.cliente_nombre}» volvió al catálogo.` : `«${e.cliente_nombre}» quedó desactivada.`);
  }

  function guardada(e: Experiencia, nueva: boolean) {
    setLectura((l) => (l.estado === "ok" ? { ...l, filas: ordenar([...l.filas.filter((x) => x.id !== e.id), e]) } : l));
    setEditando(null);
    mostrar(nueva ? `Experiencia con «${e.cliente_nombre}» agregada.` : `Experiencia con «${e.cliente_nombre}» guardada.`);
  }

  return (
    <section className="space-y-4">
      {nodoAviso}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <p className="text-sm text-gray-500 max-w-2xl">
          Los contratos anteriores que la empresa puede acreditar. En cada licitación eliges cuáles se presentan y se arma el cuadro de experiencia. La experiencia anterior al ERP no está en ninguna otra pantalla: cárgala aquí una vez.
        </p>
        <button type="button" onClick={() => setEditando({ ...FORM_VACIO })} className={claseBotonPrimario} style={{ background: AZUL }}
          disabled={lectura.estado === "fallo" && !!lectura.fallo.sinMigracion}>
          + Agregar experiencia
        </button>
      </div>

      <div className="bg-white rounded-2xl border shadow-sm p-3 sm:p-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
        <input className={claseCampo} placeholder="Buscar por cliente, RUC, objeto, sector, zona o contacto…" value={texto}
          onChange={(e) => setTexto(e.target.value)} aria-label="Buscar experiencia" />
        <label className="flex items-center gap-2 text-sm text-gray-700 min-h-[44px] cursor-pointer select-none">
          <input type="checkbox" className="w-4 h-4" checked={verInactivas}
            onChange={(e) => { setVerInactivas(e.target.checked); setLectura({ estado: "cargando" }); }} />
          Ver desactivadas
        </label>
      </div>

      {errorAccion && <ErrorFijo texto={errorAccion} />}
      {lectura.estado === "fallo" && <AvisoFallo fallo={lectura.fallo} onReintentar={recargar} que="la experiencia de la empresa" />}

      {lectura.estado === "ok" && totales.activas > 0 && (
        <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Total de las {totales.activas} activas{texto ? " que coinciden con la búsqueda" : ""} · por moneda
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {totales.por.length === 0 && <span className="text-sm text-gray-500">Ninguna tiene importe.</span>}
            {totales.por.map((t) => (
              <span key={t.moneda} className="text-lg font-bold text-gray-900">
                {fmtImporte(t.importe, t.moneda)} <span className="text-xs font-normal text-gray-500">({t.n} contrato{t.n === 1 ? "" : "s"})</span>
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {totales.por.length > 1 && "Soles y dólares no se suman entre sí. "}
            {totales.sinImporte > 0 && `${totales.sinImporte} sin importe (no cuentan). `}
            {totales.por.length > 0 && `IGV: ${totales.conIgv} lo incluyen, ${totales.sinIgv} sin IGV, ${totales.igvSinDeclarar} sin declarar. `}
            {totales.sinSustento > 0 && `${totales.sinSustento} sin archivo de sustento.`}
          </p>
        </div>
      )}

      {lectura.estado !== "fallo" && (
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {lectura.estado === "cargando" ? (
            <Cargando texto="Leyendo la experiencia de la empresa…" />
          ) : filtradas.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              <p className="text-3xl mb-2">🏅</p>
              <p className="font-medium">
                {filas.length === 0
                  ? (verInactivas ? "No hay experiencia registrada, ni activa ni desactivada." : "No hay experiencia activa registrada. Agrega los contratos que la empresa acredita.")
                  : `Ninguna de las ${filas.length} coincide con la búsqueda.`}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1040px]">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    {["Cliente", "Objeto", "Periodo", "Sustento", "Importe", "Contacto", "Archivos", ""].map((h, i) => (
                      <th key={i} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtradas.map((e) => (
                    <tr key={e.id} className="border-t align-top" style={{ borderColor: "#f1f5f9", background: e.activo ? "white" : "#fafafa" }}>
                      <td className="p-3">
                        <div className={`font-bold ${e.activo ? "text-gray-900" : "text-gray-400"}`}>{e.cliente_nombre}</div>
                        <div className="text-xs text-gray-500 font-mono">{e.cliente_ruc ? `RUC ${e.cliente_ruc}` : "sin RUC"}</div>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {e.cliente_id != null && <Chip tono="azul">Cliente del ERP</Chip>}
                          {!e.activo && <Chip tono="gris">Desactivada</Chip>}
                        </div>
                      </td>
                      <td className="p-3 max-w-[260px]">
                        <div className="text-gray-800">{e.objeto}</div>
                        {(e.sector || e.zona) && <div className="text-xs text-gray-500">{[e.sector, e.zona].filter(Boolean).join(" · ")}</div>}
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        <div className="text-gray-800">{fechaDMY(e.inicio)}</div>
                        <div className="text-gray-500">→ {e.vigente ? <b className="text-green-700">vigente</b> : e.fin ? fechaDMY(e.fin) : "sin fecha de fin"}</div>
                      </td>
                      <td className="p-3 text-xs">
                        {e.sustento_tipo ? <div className="text-gray-800">{SUSTENTO_ETIQUETA[e.sustento_tipo]}</div> : <div className="text-gray-400">—</div>}
                        {e.sustento_ref && <div className="font-mono text-gray-500">{e.sustento_ref}</div>}
                        {e.sustento_fecha && <div className="text-gray-500">{fechaDMY(e.sustento_fecha)}</div>}
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        {e.importe != null ? (
                          <>
                            <div className="font-bold text-gray-900 text-sm">{fmtImporte(e.importe, e.moneda)}</div>
                            <div className="text-gray-500">{e.importe_incluye_igv == null ? "IGV sin declarar" : e.importe_incluye_igv ? "incluye IGV" : "sin IGV"}</div>
                          </>
                        ) : <span className="text-gray-400">sin importe</span>}
                      </td>
                      <td className="p-3 text-xs max-w-[200px]">
                        {e.contacto_nombre ? (
                          <>
                            <div className="text-gray-800">{e.contacto_nombre}</div>
                            {e.contacto_cargo && <div className="text-gray-500">{e.contacto_cargo}</div>}
                            {e.contacto_telefono && <div className="text-gray-500">{e.contacto_telefono}</div>}
                            {e.contacto_email && <div className="text-gray-500 break-all">{e.contacto_email}</div>}
                          </>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="p-3 text-xs max-w-[200px]">
                        {e.sustentos.length === 0 ? <span className="text-gray-400">ninguno</span> : (
                          <ul className="space-y-0.5">
                            {e.sustentos.map((a) => (
                              <li key={a.id}>
                                <EnlacePrivado href={a.url} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: AZUL }}>📎 {a.nombre}</EnlacePrivado>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-col gap-1.5 items-end">
                          <button type="button" className={claseBotonChico} onClick={() => setEditando(formDe(e))}>Editar</button>
                          <button type="button" className={claseBotonChico} disabled={cambiando === e.id} onClick={() => alternarActivo(e)}>
                            {cambiando === e.id ? "…" : e.activo ? "Desactivar" : "Reactivar"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editando && <ModalExperiencia inicial={editando} onCerrar={() => setEditando(null)} onGuardada={guardada} />}
    </section>
  );
}

// ─── Alta / edición ──────────────────────────────────────────────────────────

type EstadoSugerencia =
  | { estado: "nada" } | { estado: "cargando"; clienteId: number }
  | { estado: "ok"; clienteId: number; sug: SugerenciaReservas | null } | { estado: "fallo"; clienteId: number; error: string };

function ModalExperiencia({ inicial, onCerrar, onGuardada }: { inicial: Form; onCerrar: () => void; onGuardada: (e: Experiencia, nueva: boolean) => void }) {
  const [f, setF] = useState<Form>(inicial);
  const [auto, setAuto] = useState<{ nombre: string | null; ruc: string | null }>({ nombre: null, ruc: null });
  const [guardando, setGuardando] = useState(false);
  const [subiendo, setSubiendo] = useState<string | null>(null);
  const [erroresSubida, setErroresSubida] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sug, setSug] = useState<EstadoSugerencia>({ estado: "nada" });
  const [copiar, setCopiar] = useState({ inicio: false, fin: false, importe: false });
  const nueva = inicial.id == null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const hoy = fechaLima();

  // La sugerencia del ERP para el cliente elegido (solo se lee; nada pasa al formulario solo).
  const clienteId = f.cliente_id;
  useEffect(() => {
    if (clienteId == null) return;
    let vivo = true;
    sugerenciaReservas(clienteId).then((r) => {
      if (!vivo) return;
      setSug(r.ok ? { estado: "ok", clienteId, sug: r.sugerencia } : { estado: "fallo", clienteId, error: r.error });
    }).catch((e: unknown) => { if (vivo) setSug({ estado: "fallo", clienteId, error: mensaje(e) }); });
    return () => { vivo = false; };
  }, [clienteId]);

  // Elegir un cliente del ERP escribe su nombre y RUC SOLO si el campo estaba vacío o tenía lo que el
  // ERP puso antes: lo que tecleó la persona no se pisa. Quitarlo no borra lo escrito.
  const elegirCliente = (c: ClienteBuscable | null) => {
    if (c && c.id === f.cliente_id) return; // el mismo: nada que releer ni escribir
    setCopiar({ inicio: false, fin: false, importe: false });
    setSug(c ? { estado: "cargando", clienteId: c.id } : { estado: "nada" });
    if (!c) { setF((x) => ({ ...x, cliente_id: null })); return; }
    const nom = rotuloCliente(c);
    const ruc = String(c.ruc ?? "").replace(/\D/g, "");
    const ponerNombre = !f.cliente_nombre.trim() || f.cliente_nombre === auto.nombre;
    const ponerRuc = ruc.length === 11 && (!f.cliente_ruc.trim() || f.cliente_ruc === auto.ruc);
    setF((x) => ({ ...x, cliente_id: c.id, ...(ponerNombre ? { cliente_nombre: nom } : {}), ...(ponerRuc ? { cliente_ruc: ruc } : {}) }));
    setAuto({ nombre: ponerNombre ? nom : auto.nombre, ruc: ponerRuc ? ruc : auto.ruc });
  };

  const v = validarExperiencia(entradaDe(f));
  const falta = subiendo ? "Espera a que terminen de subir los archivos." : "error" in v ? v.error : null;
  const importeLeido = leerImporte(f.importe);

  async function subir(files: FileList | null) {
    if (!files || !files.length) return;
    const lista = [...files];
    setErroresSubida([]);
    const errores: string[] = [];
    for (let i = 0; i < lista.length; i++) {
      const file = lista[i];
      // El sustento va al expediente: un Word o un Excel no se pueden unir (sí los acepta el almacenamiento).
      const mime = mimeDeNombre(file.name);
      if (mime && !MIMES_SUSTENTO.includes(mime)) {
        errores.push(`«${file.name}» no se puede unir al expediente: expórtalo a PDF y súbelo de nuevo.`);
        continue;
      }
      setSubiendo(`Subiendo ${i + 1} de ${lista.length}: ${file.name}…`);
      try {
        const ref = await subirArchivo("experiencia", null, file);
        setF((x) => ({ ...x, sustentos: [...x.sustentos, ref] }));
      } catch (e) {
        errores.push(mensaje(e));
      }
    }
    setSubiendo(null);
    setErroresSubida(errores);
  }

  async function guardar() {
    if (falta) return;
    setGuardando(true);
    setError(null);
    const r = await guardarExperiencia(entradaDe(f)).catch((e: unknown): FalloDatos => ({ ok: false, error: mensaje(e) }));
    setGuardando(false);
    if (!r.ok) { setError(r.error); return; }
    onGuardada(r.fila, nueva);
  }

  const s = sug.estado === "ok" && sug.clienteId === f.cliente_id ? sug.sug : null;
  function copiarSugerencia() {
    if (!s) return;
    const lineas: string[] = [];
    if (copiar.inicio) lineas.push(`Inicio: ${fechaDMY(s.desde)} (ahora: ${f.inicio ? fechaDMY(f.inicio) : "vacío"})`);
    if (copiar.fin) lineas.push(`Fin: ${fechaDMY(s.hasta)} (ahora: ${f.vigente ? "vigente" : f.fin ? fechaDMY(f.fin) : "vacío"}) — deja de estar «vigente»`);
    if (copiar.importe) lineas.push(`Importe: ${fmtImporte(s.importe, "PEN")}, en soles y con el IGV sin declarar (ahora: ${f.importe.trim() ? `${f.importe} ${f.moneda}` : "vacío"})`);
    if (!lineas.length) return;
    if (!window.confirm(`Se escribirá en el formulario:\n\n${lineas.join("\n")}\n\nEs lo que registra Programación, no el contrato: revísalo antes de guardar.`)) return;
    setF((x) => ({
      ...x,
      ...(copiar.inicio ? { inicio: s.desde } : {}),
      ...(copiar.fin ? { fin: s.hasta, vigente: false } : {}),
      ...(copiar.importe ? { importe: s.importe.toFixed(2), moneda: "PEN" as Moneda, igv: "" as const } : {}),
    }));
    setCopiar({ inicio: false, fin: false, importe: false });
  }

  const ocupado = guardando || !!subiendo;
  const campo = (k: keyof Form, rotulo: string, opts: { max: number; placeholder?: string; tipo?: string } = { max: 120 }) => (
    <div>
      <label className={claseEtiqueta} htmlFor={`exp-${k}`}>{rotulo}</label>
      <input id={`exp-${k}`} type={opts.tipo ?? "text"} className={claseCampo} value={String(f[k] ?? "")} maxLength={opts.max}
        placeholder={opts.placeholder} disabled={guardando} onChange={(e) => set(k, e.target.value as never)} />
    </div>
  );

  return (
    <Modal titulo={nueva ? "Agregar experiencia" : `Editar experiencia · ${inicial.cliente_nombre}`} ancho="max-w-3xl"
      subtitulo="Un contrato que la empresa acredita. Lo que se escribe aquí es lo que imprime el cuadro de experiencia de cada licitación."
      onCerrar={onCerrar} ocupado={ocupado}
      pie={
        <div className="space-y-2">
          <ErrorFijo texto={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={claseBotonSecundario} onClick={onCerrar} disabled={ocupado}>Cancelar</button>
            <button type="button" className={claseBotonPrimario} style={{ background: AZUL }} disabled={!!falta || ocupado} onClick={guardar}>
              {guardando ? "Guardando…" : nueva ? "Agregar" : "Guardar cambios"}
            </button>
          </div>
          {falta && <p className="text-xs text-gray-500 sm:text-right">{falta}</p>}
        </div>
      }>
      <div className="space-y-5">
        {/* Cliente */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">Cliente</legend>
          <div>
            <span className={claseEtiqueta}>Cliente del ERP (opcional)</span>
            <CampoClienteErp valor={f.cliente_id} onElegir={elegirCliente} deshabilitado={guardando} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-3">
            {campo("cliente_nombre", "Nombre del cliente *", { max: 200, placeholder: "Como figura en el contrato" })}
            {campo("cliente_ruc", "RUC", { max: 13, placeholder: "11 dígitos" })}
          </div>
          {f.cliente_id != null && <TarjetaSugerencia sug={sug} clienteId={f.cliente_id} hoy={hoy} copiar={copiar} setCopiar={setCopiar} onCopiar={copiarSugerencia} />}
        </fieldset>

        {/* Servicio */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">Servicio</legend>
          {campo("objeto", "Objeto del servicio *", { max: 500 })}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {campo("sector", "Sector", { max: 80, placeholder: "Ej.: minería, industria, retail" })}
            {campo("zona", "Zona", { max: 200, placeholder: "Ej.: Lima Sur, Callao" })}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={claseEtiqueta} htmlFor="exp-inicio">Inicio del contrato *</label>
              <input id="exp-inicio" type="date" className={claseCampo} value={f.inicio} disabled={guardando} onChange={(e) => set("inicio", e.target.value)} />
            </div>
            <div>
              <label className={claseEtiqueta} htmlFor="exp-fin">Fin del contrato</label>
              <input id="exp-fin" type="date" className={claseCampo} value={f.vigente ? "" : f.fin} disabled={guardando || f.vigente} onChange={(e) => set("fin", e.target.value)} />
              <label className="mt-1.5 flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                <input type="checkbox" checked={f.vigente} disabled={guardando} onChange={(e) => setF((x) => ({ ...x, vigente: e.target.checked, fin: e.target.checked ? "" : x.fin }))} />
                Vigente (el servicio sigue)
              </label>
            </div>
          </div>
        </fieldset>

        {/* Sustento e importe */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">Sustento e importe</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={claseEtiqueta} htmlFor="exp-sustento">Tipo de sustento</label>
              <select id="exp-sustento" className={claseCampo} value={f.sustento_tipo} disabled={guardando} onChange={(e) => set("sustento_tipo", e.target.value as SustentoTipo | "")}>
                <option value="">— Sin indicar —</option>
                {SUSTENTOS.map((t) => <option key={t} value={t}>{SUSTENTO_ETIQUETA[t]}</option>)}
              </select>
            </div>
            {campo("sustento_ref", "N° del sustento", { max: 120, placeholder: "Ej.: OC 4500012345" })}
            <div>
              <label className={claseEtiqueta} htmlFor="exp-sfecha">Fecha del sustento</label>
              <input id="exp-sfecha" type="date" className={claseCampo} value={f.sustento_fecha} disabled={guardando} onChange={(e) => set("sustento_fecha", e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_200px] gap-3">
            <div>
              <label className={claseEtiqueta} htmlFor="exp-importe">Importe</label>
              <input id="exp-importe" inputMode="decimal" className={claseCampo} value={f.importe} disabled={guardando}
                placeholder="Vacío si no se sabe" onChange={(e) => set("importe", e.target.value)} />
              <p className="text-[11px] mt-1 text-gray-400">
                {importeLeido == null ? "Sin importe: no suma en el cuadro (no es un cero)." : Number.isNaN(importeLeido) ? "Escríbelo como 12,500.50 (coma de miles, punto decimal)." : `Se guarda: ${fmtImporte(importeLeido, f.moneda)}`}
              </p>
            </div>
            <div>
              <label className={claseEtiqueta} htmlFor="exp-moneda">Moneda</label>
              <select id="exp-moneda" className={claseCampo} value={f.moneda} disabled={guardando} onChange={(e) => set("moneda", e.target.value as Moneda)}>
                <option value="PEN">Soles (S/)</option>
                <option value="USD">Dólares (US$)</option>
              </select>
            </div>
            <div>
              <label className={claseEtiqueta} htmlFor="exp-igv">¿Incluye IGV?</label>
              <select id="exp-igv" className={claseCampo} value={f.igv} disabled={guardando} onChange={(e) => set("igv", e.target.value as Form["igv"])}>
                <option value="">No se sabe</option>
                <option value="si">Sí, incluye IGV</option>
                <option value="no">No, sin IGV</option>
              </select>
            </div>
          </div>

          <div>
            <span className={claseEtiqueta}>Archivos del sustento</span>
            {f.sustentos.length > 0 && (
              <ul className="mb-2 space-y-1">
                {f.sustentos.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs">
                    <EnlacePrivado href={a.url} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: AZUL }}>
                      📎 {a.nombre}
                    </EnlacePrivado>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-gray-400">{fmtBytes(a.bytes)}{a.paginas ? ` · ${a.paginas} pág.` : ""}</span>
                      <button type="button" className="text-red-700 underline disabled:opacity-40" disabled={ocupado}
                        onClick={() => setF((x) => ({ ...x, sustentos: x.sustentos.filter((y) => y.id !== a.id) }))}>quitar</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <input type="file" accept={ACCEPT_UNIBLE} multiple disabled={ocupado}
              className="block w-full text-sm border border-gray-200 rounded-xl p-2.5 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-bold"
              onChange={(e) => { void subir(e.target.files); e.target.value = ""; }} aria-label="Subir archivos de sustento" />
            <p className="text-[11px] text-gray-400 mt-1">
              {subiendo ?? "PDF, PNG o JPG (los que se pueden unir al expediente). Se suben al elegirlos y quedan guardados al guardar la experiencia; «quitar» los saca de esta experiencia, el archivo queda en el almacenamiento."}
            </p>
            {erroresSubida.length > 0 && (
              <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-0.5">
                {erroresSubida.map((m, i) => <p key={i}>{m}</p>)}
              </div>
            )}
          </div>
        </fieldset>

        {/* Contacto */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">Contacto de referencia</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {campo("contacto_nombre", "Nombre", { max: 120 })}
            {campo("contacto_cargo", "Cargo", { max: 120 })}
            {campo("contacto_telefono", "Teléfono", { max: 120, tipo: "tel" })}
            {campo("contacto_email", "Correo", { max: 120, tipo: "email" })}
          </div>
        </fieldset>

        <div>
          <label className={claseEtiqueta} htmlFor="exp-notas">Notas internas</label>
          <textarea id="exp-notas" className={claseCampo} rows={2} maxLength={2000} value={f.notas} disabled={guardando} onChange={(e) => set("notas", e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

/** Lo que Programación registra del cliente. INFORMATIVO: solo pasa al formulario lo marcado y confirmado. */
function TarjetaSugerencia({ sug, clienteId, hoy, copiar, setCopiar, onCopiar }: {
  sug: EstadoSugerencia; clienteId: number; hoy: FechaISO;
  copiar: { inicio: boolean; fin: boolean; importe: boolean };
  setCopiar: (c: { inicio: boolean; fin: boolean; importe: boolean }) => void;
  onCopiar: () => void;
}) {
  if (sug.estado === "nada" || sug.estado === "cargando" || sug.clienteId !== clienteId) {
    return <p className="text-xs text-gray-400">Comprobando lo que registra Programación para este cliente…</p>;
  }
  if (sug.estado === "fallo") {
    return <p className="text-xs text-gray-500 rounded-xl bg-gray-50 border border-gray-200 px-3 py-2">No se pudo leer lo que registra Programación para este cliente ({sug.error}). No hace falta para guardar.</p>;
  }
  const s = sug.sug;
  if (!s) return <p className="text-xs text-gray-500 rounded-xl bg-gray-50 border border-gray-200 px-3 py-2">Programación no tiene servicios registrados para este cliente.</p>;
  const algo = copiar.inicio || copiar.fin || copiar.importe;
  const futuro = s.hasta > hoy;
  return (
    <div className="rounded-xl border px-3 py-3 text-xs space-y-2" style={{ background: "#eef3f8", borderColor: "#0b315f22", color: "#1e3a5f" }}>
      <p className="font-bold">ℹ️ Lo que registra Programación para este cliente (dato de referencia, no del contrato)</p>
      <p>
        {s.servicios} servicio{s.servicios === 1 ? "" : "s"} no cancelado{s.servicios === 1 ? "" : "s"} (ida y retorno cuentan por separado) en {s.dias} día{s.dias === 1 ? "" : "s"},
        del <b>{fechaDMY(s.desde)}</b> al <b>{fechaDMY(s.hasta)}</b>{futuro ? " (incluye servicios programados a futuro)" : ""}.
        Suma del precio de venta: <b>{fmtImporte(s.importe, "PEN")}</b> en soles
        {s.sinPrecio > 0 ? `; ${s.sinPrecio} tramo${s.sinPrecio === 1 ? "" : "s"} sin precio (el retorno suele ir en S/ 0.00 porque la tarifa del día va en un tramo)` : ""}.
        No se sabe si incluye IGV.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={copiar.inicio} onChange={(e) => setCopiar({ ...copiar, inicio: e.target.checked })} /> Inicio = {fechaDMY(s.desde)}</label>
        {futuro ? (
          <span className="opacity-80">Fin: el último servicio es futuro ({fechaDMY(s.hasta)}); si el contrato sigue, marca «Vigente».</span>
        ) : (
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={copiar.fin} onChange={(e) => setCopiar({ ...copiar, fin: e.target.checked })} /> Fin = {fechaDMY(s.hasta)}</label>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={copiar.importe} onChange={(e) => setCopiar({ ...copiar, importe: e.target.checked })} /> Importe = {fmtImporte(s.importe, "PEN")}</label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onCopiar} disabled={!algo} className={claseBotonChico} style={{ borderColor: AZUL, color: AZUL }}>Copiar lo marcado al formulario</button>
        {!algo && <span className="text-[11px] opacity-80">Marca lo que quieras copiar.</span>}
      </div>
    </div>
  );
}
