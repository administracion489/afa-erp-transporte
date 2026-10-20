"use client";
// ──────────────────────────────────────────────────────────────────────────────
// app/cotizaciones/plantillas/page.tsx — Las plantillas del PDF de la cotización: qué imprime cada
// una y qué plantilla usa cada cotización.
//
// · La plantilla es el CONTENIDO y lleva su DISEÑO (supabase/cotizaciones-05). El diseño no se
//   cambia: para otro contenido con el mismo diseño se DUPLICA. No se borran: se desactivan.
// · El editor solo ofrece lo que el diseño imprime (`CAMPOS_POR_DISENO`, medido contra el PDF en
//   scripts/prueba-cotizacion-plantillas.mts): un control que el sistema no lee es peor que no ofrecerlo.
// · Las condiciones NULL no se rellenan: «sin condiciones propias» significa que cada cotización
//   imprime las suyas. Rellenarlas al abrir y guardar pisaba las de las cotizaciones antiguas.
// · Qué plantilla resulta de cada regla lo dice `plantillaParaUso` (lib/cotizacion-plantillas.ts), el
//   mismo motor de /cotizaciones y de la IA: esta pantalla no compone su propia versión.
// · Toda escritura pide la fila de vuelta: con RLS, sin el módulo Cotizaciones, vuelve vacía sin error.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { htmlCotizacion, type AvisoPdf, type PlantillaPdfCfg } from "@/lib/cotizacion-pdf";
import { cuentasCorporativo } from "@/lib/cotizacion-corporativo";
import { DEFAULT_CONSID_ES, normalizarIdioma, type ConsidCot } from "@/lib/cotizacion-idioma";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import { faltaColumna } from "@/lib/columna-faltante";
import {
  CAMPOS_PLANTILLA, ETIQUETA_CAMPO, ETIQUETA_DISENO, ETIQUETA_SEGMENTO, SEGMENTOS, SERVICIOS_PLANTILLA,
  SQL_PLANTILLAS_USO, TABLA_PLANTILLAS, considSnapshot, disenoDe, ejemploParaVistaPrevia, esActiva,
  esIdPlantillaValido, etiquetaCelda, idNuevaPlantilla, leeCampo, plantillaParaUso, plantillaPrincipal,
  reglasQueUsan,
  type Diseno, type PlantillaFila, type ReglaPlantilla, type Segmento, type ServicioPlantilla, type UsoPlantilla,
} from "@/lib/cotizacion-plantillas";
import { leerPlantillasYReglas } from "@/lib/cotizacion-plantillas-datos";
import { ListaCondiciones } from "@/components/cotizaciones/plantillas/ListaCondiciones";
import { ReglasUso } from "@/components/cotizaciones/plantillas/ReglasUso";
import {
  DE_FABRICA, avisoLineaIA, colorValido, contarAntiguas, filasDeVuelta, listaLimpia, mismaLista, textoOpcional,
} from "@/components/cotizaciones/plantillas/pantalla";

/** Una fila de `cotizacion_plantillas` tal como llega (`select *`). */
type Fila = PlantillaFila & Record<string, unknown>;

type Lectura =
  | { estado: "cargando" }
  | { estado: "error"; error: string }
  | { estado: "ok"; plantillas: Fila[]; reglas: ReglaPlantilla[] | null; sinDiseno: boolean };

type Conteo = { n: number } | { error: string };
type Tab = "datos" | "colores" | "condiciones" | "cuentas" | "idioma";
type ListaK = "condiciones_incluye" | "condiciones_no_incluye" | "condiciones_generales";
type ColorK = "color_primario" | "color_secundario" | "color_acento";

const LISTAS: { k: ListaK; consid: keyof ConsidCot; titulo: string; nombre: string; color: string }[] = [
  { k: "condiciones_incluye", consid: "incluye", titulo: "✅ Incluye", nombre: "Incluye", color: "#166534" },
  { k: "condiciones_no_incluye", consid: "no_incluye", titulo: "❌ No incluye", nombre: "No incluye", color: "#991b1b" },
  { k: "condiciones_generales", consid: "generales", titulo: "📋 Consideraciones generales", nombre: "Consideraciones generales", color: "#0b315f" },
];
const COLORES: ColorK[] = ["color_primario", "color_secundario", "color_acento"];
const COLOR_DEFECTO: Record<ColorK, string> = { color_primario: "#0b315f", color_secundario: "#1262bd", color_acento: "#C8A24B" };
const MAX_NOMBRE = 80;

const C = { navy: "#0b315f", white: "#fff", gray50: "#f8fafc", gray100: "#f1f5f9", gray200: "#e2e8f0", gray400: "#94a3b8", gray500: "#64748b", gray600: "#475569", gray800: "#1e293b" };
const iSt: React.CSSProperties = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 10, padding: "8px 12px", fontSize: 13, outline: "none", background: "white", boxSizing: "border-box" };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, color: C.gray500, textTransform: "uppercase", marginBottom: 6 };
const ambar: React.CSSProperties = { background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 12, padding: "10px 14px", color: "#92400e", fontSize: 12 };
const gris: React.CSSProperties = { background: "#eef3f8", border: "1px solid #c7d8ed", borderRadius: 12, padding: "10px 14px", color: C.gray600, fontSize: 12 };

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const errMsg = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? "error desconocido");

/**
 * Lo que se guarda de la plantilla: SOLO los campos que su diseño imprime (más su nombre y su
 * descripción). Comparando el de la fila guardada con el del formulario se sabe si hay cambios.
 * Los textos vacíos van en null (el diseño usa el suyo; un dato mal puesto se puede borrar) y las
 * listas NULL siguen NULL.
 */
function patchDe(f: Record<string, unknown>, d: Diseno): Record<string, unknown> {
  const out: Record<string, unknown> = {
    nombre: String(f.nombre ?? "").trim(),
    descripcion: textoOpcional(f.descripcion),
    condiciones_incluye: listaLimpia(f.condiciones_incluye),
    condiciones_no_incluye: listaLimpia(f.condiciones_no_incluye),
    condiciones_generales: listaLimpia(f.condiciones_generales),
  };
  if (leeCampo(d, "titulo_documento")) out.titulo_documento = textoOpcional(f.titulo_documento);
  if (leeCampo(d, "mensaje_cierre")) out.mensaje_cierre = textoOpcional(f.mensaje_cierre);
  for (const c of COLORES) if (leeCampo(d, c)) out[c] = textoOpcional(f[c]);
  if (leeCampo(d, "cuentas")) {
    out.mostrar_cuentas_bancarias = f.mostrar_cuentas_bancarias !== false;
    out.usar_bancos_propios = !!f.usar_bancos_propios;
    for (const n of [1, 2, 3]) for (const s of ["nombre", "cuenta", "cci"]) out[`banco_${n}_${s}`] = textoOpcional(f[`banco_${n}_${s}`]);
  }
  if (leeCampo(d, "idioma")) out.idioma = textoOpcional(f.idioma);
  return out;
}

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div role="status" style={{ position: "fixed", bottom: 28, right: 28, zIndex: 100, background: ok ? "#166534" : "#991b1b", color: "white", padding: "12px 20px", borderRadius: 14, fontWeight: 700, fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.2)", maxWidth: 380 }}>
      {ok ? "✅" : "❌"} {msg}
    </div>
  );
}

export default function PlantillasPDFPage() {
  const [lectura, setLectura] = useState<Lectura>({ estado: "cargando" });
  const [perfil, setPerfil] = useState<{ estado: "cargando" } | { estado: "ok"; perfil: PerfilEmpresa | null } | { estado: "error" }>({ estado: "cargando" });
  const [conteos, setConteos] = useState<Record<string, Conteo>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<Tab>("datos");
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState("");
  const [avisosEjemplo, setAvisosEjemplo] = useState<AvisoPdf[] | null>(null);
  const [dup, setDup] = useState<{ de: string; nombre: string; azar: string } | null>(null);
  const [creando, setCreando] = useState(false);
  const [errorDup, setErrorDup] = useState("");
  const [errorActiva, setErrorActiva] = useState<Record<string, string>>({});
  const [avisoEnlace, setAvisoEnlace] = useState("");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mostrarToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  };

  const plantillas: Fila[] = lectura.estado === "ok" ? lectura.plantillas : [];
  const reglas: ReglaPlantilla[] | null = lectura.estado === "ok" ? lectura.reglas : null;
  const sinMigracion = lectura.estado === "ok" && (lectura.sinDiseno || lectura.reglas === null);

  /** Las 12 celdas y lo que RESULTA de cada una, con el motor (sin reglas: la principal; la IA, nada). */
  const celdas = useMemo(() => {
    if (lectura.estado !== "ok") return [] as { servicio: ServicioPlantilla; segmento: Segmento; uso: UsoPlantilla }[];
    return SERVICIOS_PLANTILLA.flatMap(s => SEGMENTOS.map(g => ({
      servicio: s, segmento: g, uso: plantillaParaUso({ servicio: s, segmento: g }, lectura.plantillas, lectura.reglas),
    })));
  }, [lectura]);
  const usosDe = (id: string) => celdas.filter(c => c.uso.plantilla?.id === id);
  const usosIA = (id: string) => usosDe(id).filter(c => c.servicio === "traslado_ia");

  // ── Lectura ────────────────────────────────────────────────────────────────

  const contar = (ids: string[]) => {
    setConteos(prev => { const n = { ...prev }; for (const id of ids) delete n[id]; return n; });
    for (const id of ids) {
      contarAntiguas(supabase, id)
        .then(n => setConteos(p => ({ ...p, [id]: { n } })))
        .catch(e => setConteos(p => ({ ...p, [id]: { error: errMsg(e) } })));
    }
  };

  /** Vuelve a leer plantillas y reglas. Una lectura fallida se DICE: nunca se pinta una lista vacía. */
  const recargar = async (): Promise<Fila[] | null> => {
    try {
      const r = await leerPlantillasYReglas(supabase);
      if (!r.ok) { setLectura({ estado: "error", error: r.error }); return null; }
      const filas = r.plantillas as Fila[];
      setLectura({ estado: "ok", plantillas: filas, reglas: r.reglas, sinDiseno: r.sinDiseno });
      return filas;
    } catch (e) {
      setLectura({ estado: "error", error: `No se pudieron leer las plantillas del PDF: ${errMsg(e)}` });
      return null;
    }
  };

  // ── El editor ──────────────────────────────────────────────────────────────

  const base: Fila | null = editId ? plantillas.find(p => p.id === editId) ?? null : null;
  const diseno: Diseno | null = base ? disenoDe(base) : null;
  const patchForm = base && diseno ? patchDe(form, diseno) : null;
  const hayCambios = !!(base && diseno && patchForm && JSON.stringify(patchForm) !== JSON.stringify(patchDe(base, diseno)));

  const abrirEditor = (p: Fila, forzar = false) => {
    if (!forzar && hayCambios && editId !== p.id && !window.confirm(`Tienes cambios sin guardar en «${String(base?.nombre ?? editId)}». ¿Descartarlos y abrir «${p.nombre}»?`)) return;
    setForm({ ...p });
    setEditId(p.id);
    setTab(disenoDe(p) === "corporativo" ? "condiciones" : "datos");
    setErrorGuardar("");
    setAvisosEjemplo(null);
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  const cerrarEditor = () => {
    if (hayCambios && !window.confirm(`Tienes cambios sin guardar en «${String(base?.nombre ?? "")}». ¿Descartarlos?`)) return;
    setEditId(null); setErrorGuardar(""); setAvisosEjemplo(null);
  };

  useEffect(() => {
    let vivo = true;
    (async () => {
      const filas = await recargar();
      if (!vivo || !filas) return;
      contar(filas.map(p => p.id));
      // ?editar=<id> abre esa plantilla. Se lee de window.location (como /cotizaciones) para no
      // requerir <Suspense> de useSearchParams. El id se valida antes de buscarlo.
      const q = new URLSearchParams(window.location.search).get("editar");
      if (q) {
        if (!esIdPlantillaValido(q)) setAvisoEnlace(`El enlace pide editar «${q.slice(0, 40)}», que no es el identificador de una plantilla.`);
        else {
          const p = filas.find(x => x.id === q);
          if (p) abrirEditor(p, true);
          else setAvisoEnlace(`El enlace pide editar la plantilla «${q}», que no existe.`);
        }
      }
    })();
    (async () => {
      try {
        const { data, error } = await supabase.from("empresa_perfil").select("*").eq("id", 1).maybeSingle();
        if (!vivo) return;
        setPerfil(error ? { estado: "error" } : { estado: "ok", perfil: (data as PerfilEmpresa | null) ?? null });
      } catch { if (vivo) setPerfil({ estado: "error" }); }
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: string, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));

  const guardar = async () => {
    if (!base || !diseno || !patchForm || guardando) return;
    const patch = patchForm;
    const nombre = String(patch.nombre);
    if (!nombre) { setErrorGuardar("Ponle un nombre a la plantilla (es lo que se elige en las reglas y al imprimir)."); setTab("datos"); return; }
    if (nombre.length > MAX_NOMBRE) { setErrorGuardar(`El nombre pasa de ${MAX_NOMBRE} caracteres.`); setTab("datos"); return; }
    const colorMalo = COLORES.find(c => patch[c] != null && !colorValido(patch[c]));
    if (colorMalo) { setErrorGuardar(`${ETIQUETA_CAMPO[colorMalo]}: «${String(patch[colorMalo])}» no es un color (se escribe #RRGGBB).`); setTab("colores"); return; }

    const condCambian = LISTAS.some(l => !mismaLista(patch[l.k] as string[] | null, listaLimpia(base[l.k])));
    if (condCambian) {
      const c = conteos[base.id];
      const ia = usosIA(base.id);
      const lineas: string[] = [];
      if (!c) lineas.push("Todavía se está contando cuántas cotizaciones antiguas cambiarán de PDF.");
      else if ("error" in c) lineas.push(`No se pudo contar cuántas cotizaciones antiguas cambiarán de PDF (${c.error}).`);
      else if (c.n > 0) lineas.push(`${plural(c.n, "cotización antigua", "cotizaciones antiguas")} (guardadas antes de que cada cotización copiara sus condiciones) ${c.n === 1 ? "imprime" : "imprimen"} las condiciones de esta plantilla al reimprimirse en castellano: su PDF cambiará.`);
      lineas.push("Las cotizaciones nuevas copian estas condiciones al crearse; las que ya las copiaron no cambian.");
      if (ia.length) {
        lineas.push(`La IA del CRM usa esta plantilla en sus traslados (clientes: ${ia.map(x => ETIQUETA_SEGMENTO[x.segmento]).join(", ")}): sus próximas cotizaciones saldrán por WhatsApp con estas condiciones, sin revisión.`);
        const raras = LISTAS.flatMap(l => (patch[l.k] as string[] | null) ?? []).filter(x => avisoLineaIA(x)).length;
        if (raras) lineas.push(`${plural(raras, "línea trae", "líneas traen")} un enlace, un número largo o palabras de pago (están marcadas en ámbar): revisa que no pidan pagos.`);
      }
      const pedir = !c || "error" in c || c.n > 0 || ia.length > 0;
      if (pedir && !window.confirm(`Cambiaste las condiciones de «${nombre}».\n\n• ${lineas.join("\n• ")}\n\n¿Guardar?`)) return;
    }

    setGuardando(true); setErrorGuardar("");
    try {
      const que = `La plantilla «${nombre}»`;
      const cambios: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
      let res = await supabase.from(TABLA_PLANTILLAS).update(cambios).eq("id", base.id).select("id");
      if (res.error && faltaColumna(res.error, "updated_at")) {
        delete cambios.updated_at;
        res = await supabase.from(TABLA_PLANTILLAS).update(cambios).eq("id", base.id).select("id");
      }
      const r = filasDeVuelta(res, que);
      if (!r.ok) {
        let detalle = r.detalle;
        if (r.cero) {
          // Cero filas: falta el permiso, o la plantilla ya no existe. Se mira cuál fue.
          const { data, error } = await supabase.from(TABLA_PLANTILLAS).select("id").eq("id", base.id).limit(1);
          if (!error && (data ?? []).length === 0) detalle = `${que} ya no existe en la base. Recarga la pantalla.`;
        }
        setErrorGuardar(detalle);
        return;
      }
      const filas = await recargar();
      const nueva = filas?.find(p => p.id === base.id);
      if (nueva) setForm({ ...nueva });
      if (condCambian) contar([base.id]);
      mostrarToast(condCambian ? "Guardado. Las cotizaciones nuevas copiarán estas condiciones." : "Cambios guardados.");
    } catch (e) {
      setErrorGuardar(`No se guardó: ${errMsg(e)}`);
    } finally {
      setGuardando(false);
    }
  };

  const restaurarDeFabrica = () => {
    if (!diseno) return;
    const def = DE_FABRICA[diseno];
    if (!def) return;
    setForm(prev => {
      const n = { ...prev };
      for (const [k, v] of Object.entries(def)) if ((CAMPOS_PLANTILLA as readonly string[]).includes(k) && leeCampo(diseno, k as (typeof CAMPOS_PLANTILLA)[number])) n[k] = v;
      return n;
    });
    mostrarToast("Colores y textos de fábrica puestos (todavía sin guardar).");
  };

  /**
   * La vista previa con una cotización DE MENTIRA: lo que imprimiría una cotización NUEVA creada con
   * esta plantilla (con los cambios sin guardar). Sus condiciones son las que se le copiarían:
   * `considSnapshot` de esta plantilla con las de la principal de respaldo, como hace /cotizaciones.
   */
  const verEjemplo = (cfgCrudo: Record<string, unknown>, fila: Fila) => {
    const d = disenoDe(fila);
    const cfg = { ...fila, ...cfgCrudo, ...patchDe(cfgCrudo, d), id: fila.id } as Fila;
    const principal = plantillaPrincipal(plantillas);
    const respaldo = considSnapshot(principal && principal.id === fila.id ? cfg : principal, DEFAULT_CONSID_ES);
    const consid = considSnapshot(cfg, respaldo);
    const empresa = perfil.estado === "ok" ? perfil.perfil : null;
    const r = htmlCotizacion({ ...ejemploParaVistaPrevia(), plantilla: d, cfg, empresa, consid, idioma: normalizarIdioma(cfg.idioma) });
    if (!r.html) { window.alert(r.avisos.map(a => a.detalle).join("\n") || "No se pudo armar el PDF de ejemplo."); return; }
    const win = window.open("", "_blank");
    if (!win) { window.alert("El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para este sitio y vuelve a intentarlo."); return; }
    win.document.write(r.html); win.document.close();
    if (editId === fila.id) setAvisosEjemplo(r.avisos);
  };

  // ── Activar / desactivar ───────────────────────────────────────────────────

  /** Por qué no se puede desactivar (la principal, o la usa una regla), o null. */
  const bloqueoDesactivar = (p: Fila): string | null => {
    if (!esActiva(p)) return null;
    if (p.es_principal) return "La plantilla principal no se desactiva: es la que usa toda cotización sin regla.";
    const enUso = reglasQueUsan(reglas, p.id);
    if (enUso.length) return `No se puede desactivar: la usan las reglas ${enUso.map(etiquetaCelda).join(", ")}. Cámbialas abajo primero.`;
    return null;
  };

  const cambiarActiva = async (p: Fila) => {
    const activar = !esActiva(p);
    if (!activar && bloqueoDesactivar(p)) return;
    setErrorActiva(e => { const n = { ...e }; delete n[p.id]; return n; });
    try {
      const r = filasDeVuelta(await supabase.from(TABLA_PLANTILLAS).update({ activa: activar }).eq("id", p.id).select("id"), `La plantilla «${p.nombre}»`);
      if (!r.ok) { setErrorActiva(e => ({ ...e, [p.id]: r.detalle })); return; }
      await recargar();
      mostrarToast(activar ? `«${p.nombre}» activada.` : `«${p.nombre}» desactivada: ya no se ofrece al imprimir ni en las reglas.`);
    } catch (e) {
      setErrorActiva(x => ({ ...x, [p.id]: `No se guardó: ${errMsg(e)}` }));
    }
  };

  // ── Duplicar ───────────────────────────────────────────────────────────────

  const idDup = dup ? idNuevaPlantilla(dup.nombre, plantillas.map(p => p.id), dup.azar) : "";

  const crearCopia = async () => {
    if (!dup || creando) return;
    const src = plantillas.find(p => p.id === dup.de);
    const nombre = dup.nombre.trim();
    if (!src) { setErrorDup("La plantilla de origen ya no está en la lista. Recarga la pantalla."); return; }
    if (!nombre) { setErrorDup("Ponle un nombre a la copia."); return; }
    if (nombre.length > MAX_NOMBRE) { setErrorDup(`El nombre pasa de ${MAX_NOMBRE} caracteres.`); return; }
    if (!esIdPlantillaValido(idDup)) { setErrorDup("No se pudo armar un identificador válido con ese nombre."); return; }
    const ahora = new Date().toISOString();
    // La copia hereda TODO el contenido (diseño, colores, textos, condiciones, cuentas, idioma),
    // no es la principal y no la usa ninguna regla hasta que alguien la elija.
    const nueva: Record<string, unknown> = { ...src };
    nueva.id = idDup;
    nueva.nombre = nombre;
    nueva.es_principal = false;
    nueva.activa = true;
    nueva.diseno = disenoDe(src);
    nueva.orden = Math.max(0, ...plantillas.map(p => (typeof p.orden === "number" && Number.isFinite(p.orden) ? p.orden : 0))) + 1;
    if ("descripcion" in src) nueva.descripcion = `Copia de «${src.nombre}».`;
    if ("recomendado_para" in src) nueva.recomendado_para = null;
    if ("created_at" in src) nueva.created_at = ahora;
    if ("updated_at" in src) nueva.updated_at = ahora;
    setCreando(true); setErrorDup("");
    try {
      const r = filasDeVuelta(await supabase.from(TABLA_PLANTILLAS).insert(nueva).select("id"), `La copia «${nombre}»`);
      if (!r.ok) { setErrorDup(r.detalle); return; }
      const filas = await recargar();
      setDup(null);
      contar([idDup]);
      const creada = filas?.find(p => p.id === idDup);
      if (creada) abrirEditor(creada, true);
      mostrarToast(`«${nombre}» creada. Ninguna regla la usa todavía: elígela en «¿Qué plantilla usa cada cotización?».`);
    } catch (e) {
      setErrorDup(`No se creó: ${errMsg(e)}`);
    } finally {
      setCreando(false);
    }
  };

  // ── Pintura ────────────────────────────────────────────────────────────────

  const colorDe = (p: Record<string, unknown>, d: Diseno) =>
    leeCampo(d, "color_primario") && colorValido(p.color_primario) ? String(p.color_primario) : C.navy;

  /** «Se usa en: …», de lo que RESULTA de las reglas (no solo de las filas que apuntan aquí). */
  const textoUso = (p: Fila): { texto: string; ignoradas: { celda: string; detalle: string }[] } => {
    const usos = usosDe(p.id);
    const porRegla = usos.filter(u => u.uso.codigo === "regla").map(u => etiquetaCelda(u));
    const otras = usos.filter(u => u.uso.codigo !== "regla");
    const ignoradas = reglasQueUsan(reglas, p.id)
      .map(r => ({ r, uso: celdas.find(c => c.servicio === r.servicio && c.segmento === r.segmento)?.uso }))
      .filter(x => x.uso && x.uso.plantilla?.id !== p.id)
      .map(x => ({ celda: etiquetaCelda(x.r), detalle: x.uso!.detalle }));
    let texto: string;
    if (!usos.length) texto = "No la usa ninguna regla: solo se usa si se elige al imprimir.";
    else {
      const partes: string[] = [];
      if (porRegla.length) partes.push(porRegla.join(", "));
      if (otras.length) {
        partes.push(reglas === null
          ? "todas las cotizaciones nuevas (es la principal; todavía no hay reglas)"
          : `${otras.length === 1 ? etiquetaCelda(otras[0]) : plural(otras.length, "celda", "celdas")} sin regla (es la principal)`);
      }
      texto = `Se usa en: ${partes.join(" y ")}.`;
    }
    return { texto, ignoradas };
  };

  const listasDe = (d: Diseno) => LISTAS.filter(l => leeCampo(d, l.k));

  const condicionesResumen = (p: Fila) => {
    const ls = listasDe(disenoDe(p));
    if (!ls.some(l => Array.isArray(p[l.k]))) return { propias: false, texto: "Sin condiciones propias: cada cotización imprime las suyas." };
    return {
      propias: true,
      texto: `Condiciones propias: ${ls.map(l => Array.isArray(p[l.k]) ? `${(p[l.k] as unknown[]).length} en ${l.nombre.toLowerCase()}` : `${l.nombre.toLowerCase()} sin lista`).join(" · ")}.`,
    };
  };

  const TITULO_ANTIGUAS = "Antiguas: guardadas antes de que cada cotización copiara sus condiciones. Al reimprimirse en castellano, imprimen las condiciones de su plantilla (si la plantilla tiene). No cuenta los traslados de la IA, que imprimen las suyas.";
  const textoConteo = (p: Fila, propias: boolean): string => {
    const c = conteos[p.id];
    if (!c) return "Cotizaciones antiguas: contando…";
    if ("error" in c) return "Cotizaciones antiguas: no se pudo contar.";
    if (propias) {
      return c.n === 0
        ? "Ninguna cotización antigua imprime estas condiciones al reimprimirse."
        : `${plural(c.n, "cotización antigua imprime", "cotizaciones antiguas imprimen")} estas condiciones al reimprimirse (cambiarlas cambia su PDF).`;
    }
    return c.n === 0
      ? "Ninguna cotización antigua usa esta plantilla."
      : `${plural(c.n, "cotización antigua usa", "cotizaciones antiguas usan")} esta plantilla con sus propias condiciones.`;
  };

  const tabsDe = (d: Diseno): { id: Tab; label: string }[] => [
    { id: "datos", label: "📝 Datos" },
    ...(COLORES.some(c => leeCampo(d, c)) ? [{ id: "colores" as Tab, label: "🎨 Colores" }] : []),
    { id: "condiciones", label: "📋 Condiciones" },
    ...(leeCampo(d, "cuentas") ? [{ id: "cuentas" as Tab, label: "🏦 Cuentas" }] : []),
    { id: "idioma", label: "🌐 Idioma" },
  ];

  const cp = diseno ? colorDe(form, diseno) : C.navy;
  const iaBase = base ? usosIA(base.id) : [];
  const principalActual = plantillaPrincipal(plantillas);
  const btnBlanco: React.CSSProperties = { padding: "7px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.4)", background: "transparent", color: "white", fontWeight: 700, fontSize: 12, cursor: "pointer" };

  return (
    <div style={{ padding: "28px 16px", maxWidth: 1060, margin: "0 auto", fontFamily: "system-ui,sans-serif" }}>
      {toast && <Toast msg={toast.msg} ok={toast.ok} />}

      <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, color: C.gray800, margin: 0 }}>Plantillas PDF</h1>
          <p style={{ color: C.gray500, fontSize: 13, margin: "4px 0 0" }}>Qué imprime cada plantilla y qué plantilla usa cada cotización.</p>
        </div>
        <Link href="/cotizaciones" style={{ fontSize: 13, fontWeight: 700, color: C.navy, textDecoration: "none", padding: "8px 0" }}>← Volver a Cotizaciones</Link>
      </div>

      {avisoEnlace && <div style={{ ...ambar, marginBottom: 16 }}>⚠ {avisoEnlace}</div>}

      {lectura.estado === "cargando" && <div style={{ textAlign: "center", padding: 60, color: C.gray500 }}>Leyendo las plantillas…</div>}

      {lectura.estado === "error" && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 14, padding: "14px 18px", color: "#991b1b", fontSize: 13 }}>
          <p style={{ margin: 0, fontWeight: 800 }}>No se pudieron leer las plantillas.</p>
          <p style={{ margin: "4px 0 10px" }}>{lectura.error}</p>
          <button onClick={() => { setLectura({ estado: "cargando" }); recargar().then(f => { if (f) contar(f.map(p => p.id)); }); }}
            style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid #fca5a5", background: "white", color: "#991b1b", fontWeight: 800, cursor: "pointer" }}>↻ Reintentar</button>
        </div>
      )}

      {lectura.estado === "ok" && (
        <>
          {sinMigracion && (
            <div style={{ ...ambar, marginBottom: 18 }}>
              <p style={{ margin: 0, fontWeight: 800 }}>⚠ Falta correr {SQL_PLANTILLAS_USO} en Supabase (el despliegue no lo corre).</p>
              <p style={{ margin: "4px 0 0" }}>Sin ese SQL no se pueden duplicar plantillas ni elegir qué plantilla usa cada cotización: toda cotización nueva usa la principal, y la IA usa las condiciones de /tarifario → Zonas y traslados → Ajustes.</p>
            </div>
          )}

          {plantillas.length === 0 && (
            <div style={{ ...gris, marginBottom: 18 }}>No hay ninguna plantilla en la base (o falta la tabla cotizacion_plantillas).</div>
          )}

          {/* ── Tarjetas ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(270px,1fr))", gap: 14, marginBottom: 28 }}>
            {plantillas.map(p => {
              const d = disenoDe(p);
              const col = colorDe(p, d);
              const activa = esActiva(p);
              const bloqueo = bloqueoDesactivar(p);
              const uso = textoUso(p);
              const cond = condicionesResumen(p);
              const ia = usosIA(p.id);
              const editando = editId === p.id;
              return (
                <div key={p.id} style={{ background: C.white, border: `2px solid ${editando ? col : C.gray200}`, borderRadius: 18, padding: 16, display: "flex", flexDirection: "column", gap: 8, opacity: activa ? 1 : 0.75 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 22 }}>{p.icono || "📄"}</span>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontWeight: 900, fontSize: 14, color: C.gray800, margin: 0, wordBreak: "break-word" }}>{p.nombre}</p>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                          {p.es_principal && <span style={{ fontSize: 9, fontWeight: 900, background: C.navy, color: "white", padding: "2px 7px", borderRadius: 20 }}>PRINCIPAL</span>}
                          <span style={{ fontSize: 10, fontWeight: 700, background: C.gray100, color: C.gray600, padding: "2px 8px", borderRadius: 20 }}>Diseño {ETIQUETA_DISENO[d]}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, background: C.gray100, color: C.gray600, padding: "2px 8px", borderRadius: 20 }}>{normalizarIdioma(p.idioma) === "en" ? "EN" : "ES"}</span>
                          {ia.length > 0 && <span title="La IA del CRM manda esta plantilla en sus traslados" style={{ fontSize: 10, fontWeight: 700, background: "#ede9fe", color: "#5b21b6", padding: "2px 8px", borderRadius: 20 }}>🤖 IA</span>}
                          {!activa && <span style={{ fontSize: 10, fontWeight: 800, background: "#fee2e2", color: "#991b1b", padding: "2px 8px", borderRadius: 20 }}>DESACTIVADA</span>}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => cambiarActiva(p)}
                      disabled={!!bloqueo}
                      aria-label={activa ? "Desactivar plantilla" : "Activar plantilla"}
                      title={bloqueo ?? (activa ? "Desactivar" : "Activar")}
                      style={{ flexShrink: 0, width: 42, height: 24, borderRadius: 12, border: "none", cursor: bloqueo ? "not-allowed" : "pointer", background: activa ? "#16a34a" : "#cbd5e1", position: "relative", opacity: bloqueo ? 0.5 : 1 }}
                    >
                      <span style={{ position: "absolute", top: 4, left: activa ? 22 : 4, width: 16, height: 16, borderRadius: "50%", background: "white" }} />
                    </button>
                  </div>
                  {p.descripcion && <p style={{ color: C.gray500, fontSize: 11, margin: 0 }}>{p.descripcion}</p>}
                  <p style={{ fontSize: 12, color: C.gray800, margin: 0 }}>{uso.texto}</p>
                  {uso.ignoradas.map(x => (
                    <p key={x.celda} style={{ ...ambar, margin: 0, padding: "6px 10px", fontSize: 11 }}>⚠ {x.detalle}</p>
                  ))}
                  <p style={{ fontSize: 12, color: C.gray600, margin: 0 }}>{cond.texto}</p>
                  <p title={TITULO_ANTIGUAS} style={{ fontSize: 11, color: C.gray500, margin: 0 }}>{textoConteo(p, cond.propias)}</p>
                  {bloqueo && <p style={{ fontSize: 11, color: C.gray500, margin: 0 }}>🔒 {bloqueo}</p>}
                  {errorActiva[p.id] && <p style={{ fontSize: 11, color: "#991b1b", fontWeight: 700, margin: 0 }}>✕ {errorActiva[p.id]}</p>}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto", paddingTop: 4 }}>
                    <button onClick={() => (editando ? cerrarEditor() : abrirEditor(p))}
                      style={{ flex: "1 1 110px", minHeight: 38, borderRadius: 10, border: `1px solid ${col}55`, background: editando ? col : C.gray50, color: editando ? "white" : col, fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
                      {editando ? "✓ Editando" : "⚙ Configurar"}
                    </button>
                    <button onClick={() => verEjemplo(p, p)}
                      style={{ flex: "1 1 80px", minHeight: 38, borderRadius: 10, border: `1px solid ${C.gray200}`, background: C.white, color: C.gray600, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>👁 Ejemplo</button>
                    <button onClick={() => { setErrorDup(""); setDup(dup?.de === p.id ? null : { de: p.id, nombre: `${p.nombre} (copia)`, azar: Math.random().toString(36).slice(2, 8) }); }}
                      disabled={sinMigracion}
                      style={{ flex: "1 1 80px", minHeight: 38, borderRadius: 10, border: `1px solid ${C.gray200}`, background: C.white, color: C.gray600, fontWeight: 700, fontSize: 12, cursor: sinMigracion ? "not-allowed" : "pointer", opacity: sinMigracion ? 0.5 : 1 }}>⧉ Duplicar</button>
                  </div>
                  {sinMigracion && <p style={{ fontSize: 11, color: "#92400e", margin: 0 }}>Duplicar: falta {SQL_PLANTILLAS_USO}.</p>}
                  {dup?.de === p.id && !sinMigracion && (
                    <div style={{ background: C.gray50, border: `1px solid ${C.gray200}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ ...lbl, marginBottom: 0 }} htmlFor={`dup-${p.id}`}>Nombre de la copia</label>
                      <input id={`dup-${p.id}`} value={dup.nombre} maxLength={MAX_NOMBRE} onChange={e => setDup({ ...dup, nombre: e.target.value })} style={iSt} />
                      <p style={{ fontSize: 11, color: C.gray600, margin: 0 }}>
                        Identificador: <code>{idDup || "—"}</code> · diseño {ETIQUETA_DISENO[d]}. Hereda colores, textos, condiciones, cuentas e idioma; no es la principal y ninguna regla la usa hasta que la elijas.
                      </p>
                      {errorDup && <p style={{ fontSize: 11, color: "#991b1b", fontWeight: 700, margin: 0 }}>✕ {errorDup}</p>}
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={crearCopia} disabled={creando || !dup.nombre.trim()}
                          style={{ flex: 1, minHeight: 38, borderRadius: 10, border: "none", background: C.navy, color: "white", fontWeight: 800, fontSize: 12, cursor: creando ? "wait" : "pointer", opacity: creando || !dup.nombre.trim() ? 0.6 : 1 }}>{creando ? "Creando…" : "Crear copia"}</button>
                        <button onClick={() => setDup(null)} style={{ minHeight: 38, padding: "0 14px", borderRadius: 10, border: `1px solid ${C.gray200}`, background: C.white, color: C.gray600, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
                      </div>
                      {!dup.nombre.trim() && <p style={{ fontSize: 11, color: C.gray500, margin: 0 }}>Falta el nombre.</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Editor ── */}
          {base && diseno && (
            <div ref={editorRef} style={{ background: C.white, border: `2px solid ${cp}`, borderRadius: 22, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.08)", marginBottom: 28, scrollMarginTop: 16 }}>
              <div style={{ background: cp, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <p style={{ color: "white", fontWeight: 900, fontSize: 16, margin: 0 }}>{base.icono || "📄"} {String(form.nombre || base.nombre)}</p>
                  <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 11, margin: "3px 0 0" }}>Diseño {ETIQUETA_DISENO[diseno]}{hayCambios ? " · cambios sin guardar" : ""}</p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => verEjemplo(form, base)} style={btnBlanco}>👁 Ver PDF de ejemplo</button>
                  {DE_FABRICA[diseno] && <button onClick={restaurarDeFabrica} style={btnBlanco}>↺ Colores y textos de fábrica</button>}
                  <button onClick={guardar} disabled={guardando || !hayCambios} style={{ padding: "7px 18px", borderRadius: 10, border: "none", background: "white", color: cp, fontWeight: 900, fontSize: 12, cursor: guardando || !hayCambios ? "default" : "pointer", opacity: guardando || !hayCambios ? 0.6 : 1 }}>{guardando ? "Guardando…" : "💾 Guardar"}</button>
                  <button onClick={cerrarEditor} aria-label="Cerrar el editor" style={{ ...btnBlanco, fontSize: 13 }}>✕</button>
                </div>
              </div>

              {/* Lo que imprime este diseño: sale de CAMPOS_POR_DISENO, no de una lista de esta pantalla. */}
              <div style={{ padding: "12px 20px", background: C.gray50, borderBottom: `1px solid ${C.gray200}`, fontSize: 12, color: C.gray600 }}>
                <p style={{ margin: 0 }}>
                  <b>El diseño {ETIQUETA_DISENO[diseno]} imprime:</b> {CAMPOS_PLANTILLA.filter(c => c !== "idioma" && leeCampo(diseno, c)).map(c => ETIQUETA_CAMPO[c]).join(", ")}.{" "}
                  <span style={{ color: C.gray500 }}>No imprime {CAMPOS_PLANTILLA.filter(c => c !== "idioma" && !leeCampo(diseno, c)).map(c => ETIQUETA_CAMPO[c].toLowerCase()).join(", ") || "—"}{diseno === "corporativo" ? " (su color es fijo y su título sale del idioma del PDF)" : ""}: por eso no se ofrecen.</span>
                </p>
                {iaBase.length > 0 && (
                  <p style={{ margin: "8px 0 0", color: "#5b21b6" }}>
                    🤖 La IA del CRM manda esta plantilla en sus traslados (clientes {iaBase.map(x => ETIQUETA_SEGMENTO[x.segmento]).join(", ")}): sus condiciones y sus cuentas salen por WhatsApp sin revisión. El PDF exacto que manda la IA se ve en{" "}
                    <Link href="/tarifario?vista=zonas&tab=simulador" style={{ color: "#5b21b6", fontWeight: 800 }}>/tarifario → Zonas y traslados → Simulador</Link>.
                  </p>
                )}
                <p style={{ margin: "8px 0 0", color: C.gray500 }}>«Ver PDF de ejemplo» imprime una cotización de mentira tal como saldría una NUEVA con esta plantilla, con los cambios sin guardar.</p>
              </div>

              {avisosEjemplo && avisosEjemplo.length > 0 && (
                <div style={{ padding: "10px 20px 0" }}>
                  {avisosEjemplo.map((a, i) => <p key={i} style={{ ...ambar, margin: "0 0 6px" }}>⚠ PDF de ejemplo: {a.detalle}</p>)}
                </div>
              )}

              <div style={{ background: C.gray50, borderBottom: `1px solid ${C.gray200}`, display: "flex", overflowX: "auto" }}>
                {tabsDe(diseno).map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    style={{ padding: "11px 18px", border: "none", borderBottom: `3px solid ${tab === t.id ? cp : "transparent"}`, background: "none", color: tab === t.id ? cp : C.gray600, fontWeight: tab === t.id ? 800 : 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}
                  >{t.label}</button>
                ))}
              </div>

              <div style={{ padding: 20 }}>
                {/* ── DATOS ── */}
                {tab === "datos" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label style={lbl} htmlFor="pl-nombre">Nombre</label>
                      <input id="pl-nombre" value={String(form.nombre ?? "")} maxLength={MAX_NOMBRE} onChange={e => set("nombre", e.target.value)} style={iSt} />
                      <p style={{ fontSize: 11, color: C.gray500, margin: "4px 0 0" }}>Es lo que se elige en las reglas y al imprimir. Identificador: <code>{base.id}</code> (no cambia).</p>
                    </div>
                    <div>
                      <label style={lbl} htmlFor="pl-desc">Descripción (opcional)</label>
                      <textarea id="pl-desc" value={String(form.descripcion ?? "")} onChange={e => set("descripcion", e.target.value)} rows={2} style={{ ...iSt, resize: "vertical" }} placeholder="Para qué es esta plantilla" />
                    </div>
                    {leeCampo(diseno, "titulo_documento") && (
                      <div>
                        <label style={lbl} htmlFor="pl-titulo">{ETIQUETA_CAMPO.titulo_documento}</label>
                        <input id="pl-titulo" value={String(form.titulo_documento ?? "")} onChange={e => set("titulo_documento", e.target.value)} style={iSt} placeholder="Vacío: el título del diseño" />
                      </div>
                    )}
                    {leeCampo(diseno, "mensaje_cierre") && (
                      <div>
                        <label style={lbl} htmlFor="pl-cierre">{ETIQUETA_CAMPO.mensaje_cierre}</label>
                        <textarea id="pl-cierre" value={String(form.mensaje_cierre ?? "")} onChange={e => set("mensaje_cierre", e.target.value)} rows={2} style={{ ...iSt, resize: "vertical" }} placeholder="Vacío: sin mensaje de cierre" />
                      </div>
                    )}
                    {(leeCampo(diseno, "titulo_documento") || leeCampo(diseno, "mensaje_cierre")) && (
                      <p style={{ fontSize: 11, color: C.gray500, margin: 0 }}>En un PDF en inglés no se imprimen el título ni el cierre de la plantilla (están escritos en castellano): se usa el título en inglés.</p>
                    )}
                  </div>
                )}

                {/* ── COLORES ── */}
                {tab === "colores" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div style={{ background: `linear-gradient(135deg, ${cp} 0%, ${leeCampo(diseno, "color_secundario") && colorValido(form.color_secundario) ? String(form.color_secundario) : cp} 100%)`, borderRadius: 14, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <p style={{ color: "white", fontWeight: 900, fontSize: 15, margin: 0 }}>{String(form.titulo_documento || "COTIZACIÓN")}</p>
                      {leeCampo(diseno, "color_acento") && <div style={{ width: 40, height: 40, borderRadius: 12, background: colorValido(form.color_acento) ? String(form.color_acento) : COLOR_DEFECTO.color_acento }} />}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
                      {COLORES.filter(c => leeCampo(diseno, c)).map(c => {
                        const v = String(form[c] ?? "");
                        const malo = v.trim() !== "" && !colorValido(v);
                        return (
                          <div key={c}>
                            <label style={lbl} htmlFor={`pl-${c}`}>{ETIQUETA_CAMPO[c]}</label>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <input type="color" aria-label={`${ETIQUETA_CAMPO[c]} (selector)`} value={colorValido(v) ? v.trim() : COLOR_DEFECTO[c]} onChange={e => set(c, e.target.value)} style={{ width: 44, height: 40, border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", padding: 2 }} />
                              <input id={`pl-${c}`} value={v} onChange={e => set(c, e.target.value)} style={{ ...iSt, fontFamily: "monospace", flex: 1, borderColor: malo ? "#f87171" : "#e2e8f0" }} placeholder={COLOR_DEFECTO[c]} />
                            </div>
                            {malo && <p style={{ fontSize: 11, color: "#991b1b", margin: "4px 0 0" }}>No es un color: se escribe #RRGGBB.</p>}
                          </div>
                        );
                      })}
                    </div>
                    {diseno === "moderno_fotos" && <p style={{ fontSize: 11, color: C.gray500, margin: 0 }}>En este diseño el color secundario solo se ve en el anexo del itinerario.</p>}
                  </div>
                )}

                {/* ── CONDICIONES ── */}
                {tab === "condiciones" && (() => {
                  const ls = listasDe(diseno);
                  const ninguna = ls.every(l => form[l.k] == null);
                  const c = conteos[base.id];
                  const respaldoNombre = principalActual && principalActual.id !== base.id ? `la plantilla principal «${principalActual.nombre}»` : "fábrica";
                  const avisoLinea = iaBase.length > 0 ? avisoLineaIA : undefined;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                      <div style={gris}>
                        <p style={{ margin: 0 }}>Las cotizaciones <b>nuevas</b> copian estas condiciones al crearse; desde ahí son suyas (se editan en cada cotización y no cambian con la plantilla).</p>
                        {c && !("error" in c) && c.n > 0 && (
                          <p style={{ margin: "6px 0 0" }} title={TITULO_ANTIGUAS}>{plural(c.n, "cotización antigua", "cotizaciones antiguas")} con esta plantilla {c.n === 1 ? "imprime" : "imprimen"} sus condiciones al reimprimirse en castellano: cambiarlas cambia su PDF.</p>
                        )}
                        {!c && <p style={{ margin: "6px 0 0" }}>Contando las cotizaciones antiguas que usan esta plantilla…</p>}
                        {c && "error" in c && <p style={{ margin: "6px 0 0" }}>No se pudo contar cuántas cotizaciones antiguas usan esta plantilla ({c.error}).</p>}
                      </div>

                      {ninguna ? (
                        <div style={{ background: C.gray50, border: `1px dashed ${C.gray400}`, borderRadius: 14, padding: "16px 18px" }}>
                          <p style={{ margin: 0, fontWeight: 800, fontSize: 14, color: C.gray800 }}>Sin condiciones propias: cada cotización imprime las suyas.</p>
                          <p style={{ margin: "4px 0 12px", fontSize: 12, color: C.gray600 }}>Una cotización nueva con esta plantilla empieza con las de {respaldoNombre}.</p>
                          <button onClick={() => setForm(prev => {
                            const n = { ...prev };
                            for (const l of ls) n[l.k] = [...DEFAULT_CONSID_ES[l.consid]];
                            return n;
                          })} style={{ minHeight: 38, padding: "0 16px", borderRadius: 10, border: "none", background: cp, color: "white", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>Escribir condiciones para esta plantilla</button>
                        </div>
                      ) : (
                        <>
                          {ls.map(l => {
                            const v = form[l.k];
                            if (v == null) {
                              return (
                                <div key={l.k}>
                                  <p style={{ fontWeight: 800, fontSize: 12, color: l.color, textTransform: "uppercase", margin: "0 0 6px" }}>{l.titulo}</p>
                                  <p style={{ fontSize: 12, color: C.gray600, margin: "0 0 6px" }}>Sin lista propia: cada cotización imprime la suya.</p>
                                  <button onClick={() => set(l.k, [...DEFAULT_CONSID_ES[l.consid]])} style={{ fontSize: 12, fontWeight: 700, color: l.color, background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>Escribir esta lista</button>
                                </div>
                              );
                            }
                            return (
                              <ListaCondiciones key={l.k} titulo={l.titulo} color={l.color} items={(Array.isArray(v) ? v : []).map(x => String(x ?? ""))}
                                onChange={items => set(l.k, items)} avisoLinea={avisoLinea}
                                vacia={`Lista vacía: el PDF no imprime ninguna línea en «${l.nombre}». Para que cada cotización imprima la suya, quita las condiciones de la plantilla.`} />
                            );
                          })}
                          <div style={{ borderTop: `1px solid ${C.gray200}`, paddingTop: 14 }}>
                            <button onClick={() => setForm(prev => ({ ...prev, condiciones_incluye: null, condiciones_no_incluye: null, condiciones_generales: null }))}
                              style={{ minHeight: 38, padding: "0 16px", borderRadius: 10, border: "1px solid #fca5a5", background: "#fff5f5", color: "#991b1b", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Quitar las condiciones de esta plantilla</button>
                            <p style={{ fontSize: 11, color: C.gray500, margin: "6px 0 0" }}>Sin condiciones propias, cada cotización imprime las suyas (una nueva empieza con las de {respaldoNombre}). Se aplica al guardar.</p>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* ── CUENTAS ── */}
                {tab === "cuentas" && (() => {
                  const cfgCuentas = { ...form, ...(patchForm ?? {}) } as PlantillaPdfCfg;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 10, background: C.gray50, borderRadius: 12, padding: "12px 16px", cursor: "pointer" }}>
                        <input type="checkbox" checked={form.mostrar_cuentas_bancarias !== false} onChange={e => set("mostrar_cuentas_bancarias", e.target.checked)} style={{ width: 18, height: 18, accentColor: cp }} />
                        <span style={{ fontWeight: 800, fontSize: 13, color: C.gray800 }}>Imprimir las cuentas bancarias en el PDF</span>
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 10, background: C.gray50, borderRadius: 12, padding: "12px 16px", cursor: "pointer" }}>
                        <input type="checkbox" checked={!!form.usar_bancos_propios} onChange={e => set("usar_bancos_propios", e.target.checked)} style={{ width: 18, height: 18, accentColor: cp }} />
                        <span>
                          <span style={{ display: "block", fontWeight: 800, fontSize: 13, color: C.gray800 }}>Usar cuentas propias de esta plantilla</span>
                          <span style={{ display: "block", color: C.gray500, fontSize: 11, marginTop: 2 }}>Apagado: las del Perfil de la empresa (si el perfil no tiene ninguna, las que esta plantilla tenga guardadas).</span>
                        </span>
                      </label>
                      {form.usar_bancos_propios ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          {[1, 2, 3].map(n => (
                            <div key={n} style={{ background: C.gray50, borderRadius: 12, padding: "12px 14px" }}>
                              <p style={{ fontWeight: 800, fontSize: 12, color: cp, margin: "0 0 8px" }}>Cuenta {n}</p>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
                                {([["nombre", "Banco", "BCP"], ["cuenta", "N° de cuenta", "000-000000-0-00"], ["cci", "CCI", "00000000000000000000"]] as const).map(([s, rot, ph]) => (
                                  <div key={s}>
                                    <label style={{ ...lbl, fontSize: 10 }} htmlFor={`pl-b${n}-${s}`}>{rot}</label>
                                    <input id={`pl-b${n}-${s}`} value={String(form[`banco_${n}_${s}`] ?? "")} onChange={e => set(`banco_${n}_${s}`, e.target.value)} style={{ ...iSt, fontFamily: s === "nombre" ? undefined : "monospace" }} placeholder={ph} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={gris}>Se usan las cuentas de Configuración → Perfil de la empresa.</div>
                      )}
                      {/* Lo que imprime de verdad: el mismo motor del PDF (`cuentasCorporativo`). */}
                      <div style={{ border: `1px solid ${C.gray200}`, borderRadius: 12, padding: "12px 14px" }}>
                        <p style={{ fontWeight: 800, fontSize: 12, color: C.gray800, margin: "0 0 6px" }}>Lo que imprime el PDF con esta configuración</p>
                        {perfil.estado === "cargando" && <p style={{ fontSize: 12, color: C.gray500, margin: 0 }}>Comprobando el perfil de la empresa…</p>}
                        {perfil.estado === "error" && <p style={{ fontSize: 12, color: "#92400e", margin: 0 }}>No se pudo leer el perfil de la empresa: no se puede decir qué cuentas imprime.</p>}
                        {perfil.estado === "ok" && (["PEN", "USD"] as const).map(m => {
                          const r = cuentasCorporativo(cfgCuentas, perfil.perfil, m);
                          return (
                            <div key={m} style={{ fontSize: 12, marginTop: 4 }}>
                              <b>En {m === "PEN" ? "soles" : "dólares"}:</b>{" "}
                              {cfgCuentas.mostrar_cuentas_bancarias === false
                                ? <span style={{ color: C.gray500 }}>no se imprimen (casilla apagada).</span>
                                : r.cuentas.length
                                  ? <span style={{ color: C.gray600 }}>{r.cuentas.map(x => `${x.banco} ${x.cuenta}`).join(" · ")}</span>
                                  : <span style={{ color: "#92400e" }}>{r.aviso?.detalle ?? "no se imprime el bloque de cuentas."}</span>}
                            </div>
                          );
                        })}
                      </div>
                      {iaBase.length > 0 && <p style={{ fontSize: 11, color: "#5b21b6", margin: 0 }}>🤖 La IA imprime estas cuentas en sus traslados sin revisión.</p>}
                    </div>
                  );
                })()}

                {/* ── IDIOMA ── */}
                {tab === "idioma" && (() => {
                  const raw = String(form.idioma ?? "");
                  const idi = normalizarIdioma(raw);
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <div>
                        <span style={lbl}>Idioma del PDF</span>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          {([["es", "Español"], ["en", "English"]] as const).map(([v, t]) => (
                            <button key={v} onClick={() => set("idioma", v)} aria-pressed={idi === v}
                              style={{ flex: "1 1 140px", minHeight: 44, borderRadius: 12, border: `2px solid ${idi === v ? cp : C.gray200}`, background: idi === v ? "#eef3f8" : "white", color: idi === v ? cp : C.gray600, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>{t}</button>
                          ))}
                        </div>
                      </div>
                      {raw && raw !== "es" && raw !== "en" && (
                        <div style={gris}>Está guardado como «{raw}», que el sistema lee como Español (no hay PDF bilingüe). Elige uno de los dos para dejarlo claro.</div>
                      )}
                      <div style={gris}>
                        El idioma no lo dibuja la plantilla: lo lee la cotización. Con <b>English</b>, una cotización nueva que use esta plantilla preselecciona el PDF en inglés; en inglés no se imprimen el título ni el cierre de la plantilla (están en castellano), y las condiciones copiadas salen tal cual se escribieron.
                      </div>
                      {idi === "en" && iaBase.length > 0 && (
                        <div style={ambar}>⚠ En inglés la IA deja de usar esta plantilla (sus textos del sistema solo existen en castellano): sus traslados de clientes {iaBase.map(x => ETIQUETA_SEGMENTO[x.segmento]).join(", ")} pasarían a la plantilla principal.</div>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.gray200}`, background: C.gray50, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                {errorGuardar && <p style={{ flex: "1 1 260px", margin: 0, fontSize: 12, color: "#991b1b", fontWeight: 700 }}>✕ {errorGuardar}</p>}
                {!hayCambios && !errorGuardar && <p style={{ flex: "1 1 260px", margin: 0, fontSize: 12, color: C.gray500 }}>Sin cambios por guardar.</p>}
                <button onClick={() => { setForm({ ...base }); setErrorGuardar(""); }} disabled={!hayCambios || guardando}
                  style={{ minHeight: 40, padding: "0 16px", borderRadius: 10, border: `1px solid ${C.gray200}`, background: C.white, color: C.gray600, fontWeight: 700, fontSize: 13, cursor: hayCambios ? "pointer" : "default", opacity: hayCambios ? 1 : 0.5 }}>Descartar cambios</button>
                <button onClick={guardar} disabled={guardando || !hayCambios}
                  style={{ minHeight: 40, padding: "0 22px", borderRadius: 10, border: "none", background: cp, color: "white", fontWeight: 900, fontSize: 13, cursor: guardando || !hayCambios ? "default" : "pointer", opacity: guardando || !hayCambios ? 0.6 : 1 }}>{guardando ? "Guardando…" : "💾 Guardar cambios"}</button>
              </div>
            </div>
          )}

          {/* ── Reglas de uso ── */}
          <div style={{ background: C.white, border: `1px solid ${C.gray200}`, borderRadius: 18, padding: 18 }}>
            <h2 style={{ fontSize: 18, fontWeight: 900, color: C.gray800, margin: 0 }}>¿Qué plantilla usa cada cotización?</h2>
            <p style={{ fontSize: 12, color: C.gray500, margin: "4px 0 12px" }}>
              Una regla por tipo de servicio y tipo de cliente. Se aplica al CREAR la cotización (al imprimir se puede elegir otra); una celda vacía usa la plantilla principal{principalActual ? ` («${principalActual.nombre}»)` : ""}. Solo se ofrecen las plantillas activas.
            </p>
            {reglas === null ? (
              <div style={ambar}>⚠ Las reglas no están disponibles: falta correr {SQL_PLANTILLAS_USO} en Supabase. Mientras tanto, toda cotización nueva usa la plantilla principal y la IA usa las condiciones de /tarifario → Zonas y traslados → Ajustes.</div>
            ) : (
              <ReglasUso plantillas={plantillas} reglas={reglas} aviso={mostrarToast} onCambio={async () => { await recargar(); }} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
