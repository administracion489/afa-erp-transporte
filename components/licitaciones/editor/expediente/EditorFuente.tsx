"use client";
// components/licitaciones/editor/expediente/EditorFuente.tsx — El editor de la FUENTE de un ítem del
// expediente, según su tipo. Cambia solo la fuente (por el id del ítem); qué sale de ella lo dice
// resolverExpediente y se pinta en PartesItem.
//
//  · Legajo: «el vigente» (null) o un documento FIJADO. Se enseñan los hechos de cada versión (emisión,
//    vencimiento, de dónde es el archivo); el juicio (vencido, antiguo) lo da la revisión, no esta pantalla.
//  · Adjunto: se sube al bucket privado con subirArchivo (LANZA con el motivo para el operador, que se
//    dice FIJO debajo). Solo PDF, PNG o JPG: lo demás no se puede unir y se dice antes de subir.
//  · Roles: nunca se dejan vacíos (vacío = «todos» al normalizar, que sería decir lo contrario).
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import { ErrorLicitaciones, subirArchivo } from "@/lib/licitaciones/datos";
import { origenArchivo, mimeDeNombre } from "@/lib/licitaciones/archivos";
import { documentoVigente, TIPOS_DOC_CONDUCTOR, TIPOS_LEGAJO } from "@/lib/licitaciones/legajo";
import { ETIQUETA_DOC_UNIDAD } from "@/lib/licitaciones/recursos";
import { ETIQUETA_SEGURO_LIC } from "@/lib/licitaciones/reglas";
import { baseSupabase } from "@/lib/storage-privado";
import { fechaDMY } from "@/lib/licitaciones/util";
import {
  DOCS_UNIDAD_LIC, type ArchivoRef, type CodigoDocConductor, type CodigoLegajo, type DocUnidadLic, type FilaDocEmpresa,
  type FuenteItem, type ItemExpediente, type RolConductor, type RolUnidad, type SustentoTipo, type TipoSeguroLic,
} from "@/lib/licitaciones/tipos";
import { ACCEPT_UNIBLE, fmtBytes, SUSTENTO_ETIQUETA, SUSTENTOS } from "@/components/licitaciones/etiquetas";
import type { PasoProps } from "../contrato-editor";
import { alternarRol, conItem, existeItem, ROLES_CONDUCTOR, ROLES_UNIDAD, TIPOS_SEGURO_LISTA } from "./acciones";
import { Boton, Casilla, Chip, claseSelect, Nota, Rotulo } from "./ui";

type Props = {
  p: PasoProps;
  item: ItemExpediente;
  /** Título del bloque, para las confirmaciones. */
  bloqueTitulo: string;
  editable: boolean;
  cambiarFuente: (f: FuenteItem) => void;
};

const ROTULO_ROL_U: Record<RolUnidad, string> = { titular: "Titulares", reten: "Retén" };
const ROTULO_ROL_C: Record<RolConductor, string> = { titular: "Titulares", relevo: "Relevo" };
const ROTULO_TABLA = { relacion_unidades: "Relación de unidades", relacion_conductores: "Relación de conductores", contactos: "Personas de contacto para emergencias" } as const;

export default function EditorFuente({ p, item, bloqueTitulo, editable, cambiarFuente }: Props) {
  const f = item.fuente;
  switch (f.tipo) {
    case "legajo": return <FuenteLegajo p={p} f={f} editable={editable} cambiar={cambiarFuente} />;
    case "docs_unidades":
      return (
        <div className="space-y-2">
          <Rotulo texto="Documento">
            <select className={claseSelect} disabled={!editable} value={f.doc} onChange={(e) => cambiarFuente({ ...f, doc: e.target.value as DocUnidadLic })}>
              {DOCS_UNIDAD_LIC.map((d) => <option key={d} value={d}>{ETIQUETA_DOC_UNIDAD[d]}</option>)}
            </select>
          </Rotulo>
          <RolesUnidad p={p} roles={f.roles} editable={editable} cambiar={(roles) => cambiarFuente({ ...f, roles })} que="un documento por unidad" />
        </div>
      );
    case "fotos_unidades":
      return <RolesUnidad p={p} roles={f.roles} editable={editable} cambiar={(roles) => cambiarFuente({ ...f, roles })} que="exterior e interior de cada unidad" />;
    case "fichas_unidades":
      return <RolesUnidad p={p} roles={f.roles} editable={editable} cambiar={(roles) => cambiarFuente({ ...f, roles })} que="una hoja por unidad, armada por el ERP" />;
    case "docs_conductores":
      return (
        <div className="space-y-2">
          <Rotulo texto="Documento">
            <select className={claseSelect} disabled={!editable} value={f.doc} onChange={(e) => cambiarFuente({ ...f, doc: e.target.value as CodigoDocConductor })}>
              {TIPOS_DOC_CONDUCTOR.map((t) => <option key={t.codigo} value={t.codigo}>{t.etiqueta}</option>)}
            </select>
          </Rotulo>
          <RolesConductor p={p} roles={f.roles} editable={editable} cambiar={(roles) => cambiarFuente({ ...f, roles })} />
        </div>
      );
    case "cuadro_experiencia":
      return (
        <p className="text-xs text-gray-600">
          Hoja que arma el ERP con los {p.doc.experiencia.ids.length} contrato{p.doc.experiencia.ids.length === 1 ? "" : "s"} elegido{p.doc.experiencia.ids.length === 1 ? "" : "s"} en Recursos, firmada por el representante legal.{" "}
          <button type="button" onClick={() => p.irA("recursos", "experiencia")} className="font-semibold text-[#0b315f] underline">Elegir contratos</button>
        </p>
      );
    case "sustentos_experiencia":
      return (
        <div className="space-y-1">
          <Rotulo texto="Qué sustentos">
            <select className={claseSelect} disabled={!editable} value={f.clase} onChange={(e) => cambiarFuente({ ...f, clase: e.target.value as SustentoTipo | "todos" })}>
              <option value="todos">Todos (órdenes, comprobantes, cartas o conformidades)</option>
              {SUSTENTOS.map((s) => <option key={s} value={s}>{SUSTENTO_ETIQUETA[s]}</option>)}
            </select>
          </Rotulo>
          <p className="text-[11px] text-gray-500">
            De los {p.doc.experiencia.ids.length} contrato{p.doc.experiencia.ids.length === 1 ? "" : "s"} elegido{p.doc.experiencia.ids.length === 1 ? "" : "s"} en Recursos. Los archivos se suben en el{" "}
            <Link href="/licitaciones?tab=experiencia" target="_blank" rel="noopener noreferrer" className="font-semibold text-[#0b315f] underline">catálogo de experiencia ↗</Link>.
          </p>
        </div>
      );
    case "seguro":
      return (
        <div className="space-y-1">
          <Rotulo texto="Póliza">
            <select className={claseSelect} disabled={!editable} value={f.seguro} onChange={(e) => cambiarFuente({ ...f, seguro: e.target.value as TipoSeguroLic })}>
              {TIPOS_SEGURO_LISTA.map((s) => <option key={s} value={s}>{ETIQUETA_SEGURO_LIC[s]}</option>)}
            </select>
          </Rotulo>
          <p className="text-[11px] text-gray-500">
            Sale la póliza vigente registrada en{" "}
            <Link href="/seguros" target="_blank" rel="noopener noreferrer" className="font-semibold text-[#0b315f] underline">Seguros ↗</Link>, con su archivo.
          </p>
        </div>
      );
    case "adjunto": return <FuenteAdjunto p={p} item={item} archivo={f.archivo} bloqueTitulo={bloqueTitulo} editable={editable} />;
    case "tabla":
      return (
        <Rotulo texto="Tabla" ayuda="Se arma con lo elegido en Recursos (la misma tabla que sale en la propuesta).">
          <select className={claseSelect} disabled={!editable} value={f.tabla} onChange={(e) => cambiarFuente({ tipo: "tabla", tabla: e.target.value as keyof typeof ROTULO_TABLA })}>
            {(Object.keys(ROTULO_TABLA) as (keyof typeof ROTULO_TABLA)[]).map((t) => <option key={t} value={t}>{ROTULO_TABLA[t]}</option>)}
          </select>
        </Rotulo>
      );
    case "propuesta":
      return (
        <div className="space-y-1">
          <p className="text-xs text-gray-600">La propuesta técnica del paso 3 (Contenido) va dentro de este bloque, con sus hojas.</p>
          {p.doc.expediente.propuestaEnCompleto === "primero" && (
            <Nota tono="ambar">
              En el expediente completo la propuesta también va <b>primero</b>: saldría dos veces. Quita este ítem o elige «No incluirla» en el foliado.{" "}
              <button type="button" onClick={() => p.irA("expediente", "foliado")} className="font-semibold underline">Ir al foliado</button>
            </Nota>
          )}
        </div>
      );
  }
}

// ══ Roles ═════════════════════════════════════════════════════════════════════════

function RolesUnidad({ p, roles, editable, cambiar, que }: { p: PasoProps; roles: RolUnidad[]; editable: boolean; cambiar: (r: RolUnidad[]) => void; que: string }) {
  const n = p.doc.unidades.filter((u) => roles.includes(u.rol)).length;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Unidades</span>
        {ROLES_UNIDAD.map((r) => (
          <Casilla key={r} marcado={roles.includes(r)} disabled={!editable || (roles.length === 1 && roles[0] === r)}
            title={roles.length === 1 && roles[0] === r ? "Al menos un rol" : undefined}
            cambiar={(v) => cambiar(alternarRol(roles, ROLES_UNIDAD, r, v))}>{ROTULO_ROL_U[r]}</Casilla>
        ))}
      </div>
      <p className="text-[11px] text-gray-500">
        {n === 0 ? "No hay unidades con ese rol elegidas en Recursos: este ítem no sacaría nada. " : `${n} unidad${n === 1 ? "" : "es"} elegida${n === 1 ? "" : "s"} · ${que}. `}
        <button type="button" onClick={() => p.irA("recursos", "unidades")} className="font-semibold text-[#0b315f] underline">Ver en Recursos</button>
      </p>
    </div>
  );
}

function RolesConductor({ p, roles, editable, cambiar }: { p: PasoProps; roles: RolConductor[]; editable: boolean; cambiar: (r: RolConductor[]) => void }) {
  const n = p.doc.conductores.filter((c) => roles.includes(c.rol)).length;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Conductores</span>
        {ROLES_CONDUCTOR.map((r) => (
          <Casilla key={r} marcado={roles.includes(r)} disabled={!editable || (roles.length === 1 && roles[0] === r)}
            title={roles.length === 1 && roles[0] === r ? "Al menos un rol" : undefined}
            cambiar={(v) => cambiar(alternarRol(roles, ROLES_CONDUCTOR, r, v))}>{ROTULO_ROL_C[r]}</Casilla>
        ))}
      </div>
      <p className="text-[11px] text-gray-500">
        {n === 0 ? "No hay conductores con ese rol elegidos en Recursos: este ítem no sacaría nada. " : `${n} conductor${n === 1 ? "" : "es"} · uno por conductor. `}
        <button type="button" onClick={() => p.irA("recursos", "conductores")} className="font-semibold text-[#0b315f] underline">Ver en Recursos</button>
      </p>
    </div>
  );
}

// ══ Legajo ════════════════════════════════════════════════════════════════════════

const GRUPOS_LEGAJO = [...new Set(TIPOS_LEGAJO.map((t) => t.grupo))];

/** Las versiones de un tipo, la más reciente primero (solo para enseñarlas; cuál vale lo decide documentoVigente). */
function versionesDe(codigo: string, filas: readonly FilaDocEmpresa[]): FilaDocEmpresa[] {
  return filas.filter((f) => f.categoria === codigo).sort((a, b) => {
    const ea = a.fecha_emision ?? "", eb = b.fecha_emision ?? "";
    if (ea !== eb) return ea < eb ? 1 : -1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return b.id - a.id;
  });
}

function origenTexto(url: string | null): string {
  const o = origenArchivo(url, baseSupabase());
  return o === "vacio" ? "sin archivo" : o === "externo" ? "enlace externo (no se puede unir)" : "con archivo";
}

function rotuloFila(f: FilaDocEmpresa): string {
  const partes = [f.titulo || f.archivo_nombre || `Documento #${f.id}`];
  if (f.fecha_emision) partes.push(`emitido ${fechaDMY(f.fecha_emision)}`);
  if (f.fecha_vencimiento) partes.push(`vence ${fechaDMY(f.fecha_vencimiento)}`);
  partes.push(origenTexto(f.archivo_url));
  return partes.join(" · ");
}

function FuenteLegajo({ p, f, editable, cambiar }: { p: PasoProps; f: Extract<FuenteItem, { tipo: "legajo" }>; editable: boolean; cambiar: (f: FuenteItem) => void }) {
  const ctx = p.ctx;
  const leido = !!ctx && ctx.lecturas.legajo === "ok";
  const filas = useMemo(() => (leido && ctx ? versionesDe(f.codigo, ctx.legajo) : []), [leido, ctx, f.codigo]);
  const vigente = leido && ctx ? documentoVigente(f.codigo, ctx.legajo, null) : null;
  const fijadoFalta = leido && f.documentoId != null && !filas.some((x) => x.id === f.documentoId);

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Rotulo texto="Documento del legajo">
          <select className={claseSelect} disabled={!editable} value={f.codigo}
            onChange={(e) => cambiar({ tipo: "legajo", codigo: e.target.value as CodigoLegajo, documentoId: null })}>
            {GRUPOS_LEGAJO.map((g) => (
              <optgroup key={g} label={g}>
                {TIPOS_LEGAJO.filter((t) => t.grupo === g).map((t) => <option key={t.codigo} value={t.codigo}>{t.etiqueta}</option>)}
              </optgroup>
            ))}
          </select>
        </Rotulo>
        <Rotulo texto="Qué versión">
          {!ctx ? (
            <p className="py-2 text-xs text-gray-500">Comprobando el legajo…</p>
          ) : !leido ? (
            <p className="py-2 text-xs text-gray-600">No se pudo leer el legajo: no se afirma que falte. Recarga para reintentar.</p>
          ) : (
            <select className={claseSelect} disabled={!editable} value={f.documentoId == null ? "" : String(f.documentoId)}
              onChange={(e) => cambiar({ ...f, documentoId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">El vigente: el más reciente con archivo</option>
              {filas.map((x) => <option key={x.id} value={String(x.id)}>{rotuloFila(x)}</option>)}
              {fijadoFalta && <option value={String(f.documentoId)}>Documento #{f.documentoId} (ya no está en el legajo)</option>}
            </select>
          )}
        </Rotulo>
      </div>
      {leido && (
        <p className="text-[11px] text-gray-500">
          {filas.length === 0
            ? "No hay ningún documento de este tipo en el legajo. "
            : f.documentoId == null && vigente
              ? <>Hoy sale: «{rotuloFila(vigente)}». Si mañana subes uno más reciente, sale ese. </>
              : <>Fijado: sale siempre esa versión, aunque se suba una más reciente. </>}
          <Link href="/licitaciones?tab=legajo" target="_blank" rel="noopener noreferrer" className="font-semibold text-[#0b315f] underline">Abrir el Legajo de la empresa ↗</Link>
        </p>
      )}
      {fijadoFalta && <Nota tono="ambar">El documento fijado ya no está en el legajo: al emitir se usará el más reciente. Elige otra versión o deja «el vigente».</Nota>}
    </div>
  );
}

// ══ Adjunto ═══════════════════════════════════════════════════════════════════════

const UNIBLES = ["application/pdf", "image/png", "image/jpeg"];
const NO_UNIBLE_POR_EXT: Record<string, string> = {
  docx: "un Word", doc: "un Word", xlsx: "un Excel", xls: "un Excel", zip: "un archivo comprimido", rar: "un archivo comprimido",
};

/** Lo que se dice ANTES de subir algo que el expediente no puede unir (null = se intenta la subida). */
function motivoNoUnible(file: File): string | null {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (NO_UNIBLE_POR_EXT[ext]) return `«${file.name}» es ${NO_UNIBLE_POR_EXT[ext]}: el expediente solo puede unir PDF, PNG o JPG. Expórtalo como PDF y súbelo.`;
  const mime = file.type || mimeDeNombre(file.name) || "";
  if (mime && !UNIBLES.includes(mime) && !/hei[cf]/i.test(mime) && !/\.hei[cf]$/i.test(file.name)) {
    return `«${file.name}» no es PDF, PNG ni JPG: el expediente no lo puede unir.`;
  }
  return null;
}

function FuenteAdjunto({ p, item, archivo, bloqueTitulo, editable }: { p: PasoProps; item: ItemExpediente; archivo: ArchivoRef | null; bloqueTitulo: string; editable: boolean }) {
  const [subiendo, setSubiendo] = useState<string | null>(null);
  /** `sql`: la subida falló porque falta una migración (el texto ya la nombra): ámbar, no rojo. */
  const [error, setError] = useState<{ texto: string; sql: string | null } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const nombreItem = item.titulo?.trim() || archivo?.nombre || "este ítem";

  const subir = async (file: File) => {
    setError(null);
    const no = motivoNoUnible(file);
    if (no) { setError({ texto: no, sql: null }); return; }
    if (archivo && !window.confirm(`¿Reemplazar «${archivo.nombre}» por «${file.name}» en «${nombreItem}» (${bloqueTitulo})?\n\nEl anterior sigue guardado en el ERP, pero deja de unirse al expediente.`)) return;
    setSubiendo(file.name);
    try {
      const ref = await subirArchivo("adjuntos", p.lic.id, file);
      // Por id, sobre el doc de AHORA: mientras subía pudo reordenarse o quitarse el ítem.
      const hecho = { quedo: false };
      p.cambiarDoc((d) => {
        if (!existeItem(d, item.id)) return d;
        hecho.quedo = true;
        return conItem(d, item.id, (i) => (i.fuente.tipo === "adjunto" ? { ...i, fuente: { tipo: "adjunto", archivo: ref } } : i));
      });
      if (hecho.quedo) p.aviso(`«${ref.nombre}» se subió a «${nombreItem}».`);
      else p.aviso(`«${ref.nombre}» se subió, pero el ítem ya no existe (o la licitación pasó a solo lectura): el archivo quedó guardado sin usar.`, "aviso");
    } catch (e) {
      if (e instanceof ErrorLicitaciones) setError({ texto: e.message, sql: e.sinMigracion });
      else setError({ texto: `No se pudo subir «${file.name}»: ${e instanceof Error ? e.message : String(e)}. Revisa tu conexión y vuelve a intentarlo.`, sql: null });
    } finally {
      setSubiendo(null);
      if (input.current) input.current.value = "";
    }
  };

  const quitar = () => {
    if (!archivo) return;
    if (!window.confirm(`¿Quitar «${archivo.nombre}» de «${nombreItem}» (${bloqueTitulo})?\n\nEl archivo sigue guardado en el ERP, pero el ítem queda pendiente de subir y no se une al expediente.`)) return;
    p.cambiarDoc((d) => conItem(d, item.id, (i) => (i.fuente.tipo === "adjunto" ? { ...i, fuente: { tipo: "adjunto", archivo: null } } : i)));
  };

  const pdfSinLeer = archivo?.mime === "application/pdf" && archivo.paginas == null;
  const unible = !!archivo && UNIBLES.includes(archivo.mime);

  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept={ACCEPT_UNIBLE} className="hidden" aria-hidden="true" tabIndex={-1}
        onChange={(e) => { const file = e.target.files?.[0]; if (file) void subir(file); }} />
      {archivo ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2">
          <span className="min-w-0 flex-1 break-words text-sm text-gray-800">
            📄 {archivo.nombre}
            <span className="ml-1 text-[11px] text-gray-500">
              {[fmtBytes(archivo.bytes), archivo.paginas ? `${archivo.paginas} pág.` : null].filter(Boolean).join(" · ")}
            </span>
          </span>
          {!unible && <Chip tono="ambar">No se puede unir</Chip>}
          <EnlacePrivado href={archivo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-[#0b315f] underline">Ver</EnlacePrivado>
          {editable && (
            <>
              <Boton chico onClick={() => input.current?.click()} disabled={!!subiendo}>Reemplazar</Boton>
              <Boton chico tono="peligro" onClick={quitar} disabled={!!subiendo}>Quitar archivo</Boton>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {editable
            ? <Boton chico tono="primario" onClick={() => input.current?.click()} disabled={!!subiendo}>{subiendo ? "Subiendo…" : "Subir archivo (PDF, PNG o JPG)"}</Boton>
            : null}
          <span className="text-xs text-red-700">Pendiente de subir: no sale en el expediente hasta que se suba.</span>
        </div>
      )}
      {subiendo && <p className="text-xs text-gray-500">Subiendo «{subiendo}»…</p>}
      {pdfSinLeer && (
        <Nota tono="ambar">
          No se pudieron contar las páginas de este PDF: puede estar protegido con contraseña o dañado. Al emitir se comprueba; si está cifrado, se omite del expediente y se nombra. Sube una versión sin protección.
        </Nota>
      )}
      {!unible && archivo && <Nota tono="ambar">«{archivo.nombre}» no es PDF ni imagen: se omitirá del expediente unido. Súbelo como PDF, PNG o JPG.</Nota>}
      {error && (
        <div role="alert" className={`rounded-lg border px-3 py-2 text-xs ${error.sql ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800"}`}>
          {error.texto}
        </div>
      )}
    </div>
  );
}
