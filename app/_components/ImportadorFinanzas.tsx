"use client";

// ──────────────────────────────────────────────────────────────────────────────
// app/_components/ImportadorFinanzas.tsx — Modal reutilizable de importación.
//
// Lo usan Caja Chica, Cuentas por Pagar y (en general) cualquier pantalla que suba
// un Google Sheet o un Excel histórico. La razón de que exista es el PASO 2: hoy el
// repo importa a ciegas — si una cabecera no calza, el archivo entero se aborta y el
// usuario no tiene forma de arreglarlo sin editar el Sheet a mano. Aquí se ve qué
// perfil se detectó, se puede corregir el mapeo columna por columna y se revisan las
// filas válidas ANTES de escribir en la base.
//
// El parseo es todo del navegador (lib/importador/tabular); al endpoint solo viajan
// filas ya construidas y validadas. Ver la cabecera de app/api/finanzas/importar.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import {
  aplicarPerfil,
  descargarGoogleSheet,
  detectarPerfil,
  leerArchivo,
  mapearColumnas,
  puntuarPerfiles,
  type FilaError,
  type FilasCrudas,
  type Perfil,
  type PuntajePerfil,
  type ResultadoImport,
} from "@/lib/importador/tabular";
import { descargarPlantilla, descargarRechazos } from "@/lib/finanzas/exportar";

// ── Contrato público ──────────────────────────────────────────────────────────

export type ResumenImportacion = {
  perfil: string;
  destino: string;
  leidas: number;
  creadas: number;
  actualizadas: number;
  omitidas: number;
  errores: { fila?: number; motivo: string }[];
  importacion_id?: number;
};

export type ImportadorProps = {
  abierto: boolean;
  onCerrar: () => void;
  // Cada perfil construye una fila con su propia forma (FilaCxP, FilaCajaChica…), así
  // que el genérico queda abierto en el contrato y se estrecha puertas adentro.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfiles: Perfil<any>[];
  titulo: string;
  descripcion?: string;
  extras?: Record<string, unknown>;
  onImportado?: (resumen: ResumenImportacion) => void;
  plantilla?: { cabeceras: string[]; ejemplos?: unknown[][]; instrucciones: string[] };
};

/** Fila ya construida por un perfil: un objeto plano listo para el endpoint. */
type FilaImportada = Record<string, unknown>;

/**
 * El endpoint rechaza cargas de más de 5000 filas (tiene 60 s de ejecución), así que
 * el cliente parte en tandas holgadas y las sube en serie acumulando el resumen.
 */
const TANDA = 2000;

const NAVY = "#0b315f";
const VERDE = { color: "#166534", bg: "#dcfce7" };
const ROJO = { color: "#991b1b", bg: "#fee2e2" };
const AMBAR = { color: "#854d0e", bg: "#fef9c3" };

// ── Helpers locales ───────────────────────────────────────────────────────────

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

/** A, B, … Z, AA — para nombrar columnas sin cabecera como las nombra Excel. */
function letraColumna(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** "proveedor_razon_social" → "Proveedor razón social" (solo para mostrar). */
function etiquetaCampo(campo: string): string {
  const t = campo.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const CLAVES_DINERO = /(monto|total|subtotal|igv|adelanto|saldo|cargo|abono|detraccion_monto)/;

function fmtCelda(clave: string, valor: unknown, moneda: string): string {
  if (valor == null || valor === "") return "—";
  if (typeof valor === "boolean") return valor ? "Sí" : "No";
  if (typeof valor === "number") {
    return CLAVES_DINERO.test(clave) ? fmtMoneda(valor, moneda) : String(valor);
  }
  const s = String(valor);
  // El importador emite fechas civiles "YYYY-MM-DD"; el sufijo T00:00:00 es obligatorio
  // o UTC-5 las corre un día hacia atrás.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(s + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  return s;
}

const PASOS = [
  { n: 1, label: "Origen" },
  { n: 2, label: "Revisión" },
  { n: 3, label: "Resultado" },
] as const;

// ── Componente ────────────────────────────────────────────────────────────────

export default function ImportadorFinanzas(props: ImportadorProps) {
  const { abierto, onCerrar, titulo, descripcion, extras, onImportado, plantilla } = props;

  const [paso, setPaso] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [enlace, setEnlace] = useState("");

  const [crudas, setCrudas] = useState<FilasCrudas | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState("");
  const [ranking, setRanking] = useState<PuntajePerfil[]>([]);
  const [autoDetectado, setAutoDetectado] = useState(false);
  const [perfilClave, setPerfilClave] = useState("");
  const [mapa, setMapa] = useState<Record<string, number>>({});
  const [resultado, setResultado] = useState<ResultadoImport<FilaImportada> | null>(null);
  // Fecha de referencia para las filas del histórico que no traen ninguna fecha propia.
  // En la planilla real de OSLO Piura son 47 de 108: recibos por honorarios cuyo único
  // dato temporal es un rango escrito a mano ("14-19 DE OCTUBRE"). Rechazarlas sería
  // botar media carga; inventarles una fecha en silencio sería peor.
  const [fechaPorDefecto, setFechaPorDefecto] = useState("");

  const [subiendo, setSubiendo] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [tandaMsg, setTandaMsg] = useState("");
  const [resumen, setResumen] = useState<ResumenImportacion | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  // El genérico abierto del contrato se estrecha aquí una sola vez.
  const perfiles = useMemo(
    () => props.perfiles as unknown as Perfil<FilaImportada>[],
    [props.perfiles]
  );
  const perfilSel = useMemo(
    () => perfiles.find((p) => p.clave === perfilClave) ?? null,
    [perfiles, perfilClave]
  );

  // Cada apertura arranca limpia: un modal que recuerda el archivo anterior invita a
  // volver a importarlo sin querer. El reinicio se hace DURANTE EL RENDER comparando
  // contra el valor anterior de `abierto` —el patrón que React recomienda para estado
  // derivado de una prop— y no en un useEffect, que provocaría un primer render con
  // los datos de la importación pasada aún en pantalla.
  const [abiertoAntes, setAbiertoAntes] = useState(abierto);
  if (abierto !== abiertoAntes) {
    setAbiertoAntes(abierto);
    if (abierto) {
      setPaso(1);
      setError(null);
      setLeyendo(false);
      setArrastrando(false);
      setEnlace("");
      setCrudas(null);
      setNombreArchivo("");
      setRanking([]);
      setAutoDetectado(false);
      setPerfilClave("");
      setMapa({});
      setResultado(null);
      setFechaPorDefecto("");
      setSubiendo(false);
      setProgreso(0);
      setTandaMsg("");
      setResumen(null);
    }
  }

  // ── Paso 1 · lectura ────────────────────────────────────────────────────────

  const analizar = useCallback(
    (c: FilasCrudas, nombre: string) => {
      const rank = puntuarPerfiles(c.cabeceras, perfiles);
      const detectado = detectarPerfil(c.cabeceras, perfiles);
      // Si nadie calza del todo se preselecciona el mejor puntuado igual: así el usuario
      // aterriza en la tabla de mapeo (que es lo que salva el archivo) en vez de en una
      // pantalla muerta. El select le deja cambiarlo.
      const elegido = detectado ?? perfiles.find((p) => p.clave === rank[0]?.clave) ?? perfiles[0] ?? null;

      setCrudas(c);
      setNombreArchivo(nombre);
      setRanking(rank);
      setAutoDetectado(!!detectado);

      if (elegido) {
        const m = mapearColumnas(c.cabeceras, elegido.campos);
        setPerfilClave(elegido.clave);
        setMapa(m);
        setResultado(aplicarPerfil(c, elegido, { fecha_por_defecto: fechaPorDefecto || null }, m));
      } else {
        setPerfilClave("");
        setMapa({});
        setResultado(null);
      }
      setPaso(2);
    },
    [perfiles, fechaPorDefecto]
  );

  async function cargarArchivo(file: File) {
    // El botón se deshabilita mientras lee, pero la zona de arrastre no: sin esta guarda
    // dos archivos soltados seguidos se parsean a la vez y gana el que termine último.
    if (leyendo) return;
    setLeyendo(true);
    setError(null);
    try {
      const c = await leerArchivo(file);
      analizar(c, file.name);
    } catch (e: unknown) {
      // Archivo vacío, sin hoja legible o por encima de MAX_FILAS: se queda en el paso 1.
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLeyendo(false);
      // Sin esto el navegador no vuelve a disparar onChange con el MISMO archivo, y el
      // usuario que corrige su Excel y lo re-arrastra cree que el modal se colgó.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function cargarEnlace() {
    if (!enlace.trim()) return;
    setLeyendo(true);
    setError(null);
    try {
      const file = await descargarGoogleSheet(enlace.trim());
      const c = await leerArchivo(file);
      analizar(c, file.name);
    } catch (e: unknown) {
      // El mensaje de descargarGoogleSheet ya explica cómo compartir la hoja: se
      // muestra tal cual, sin envolverlo en un texto genérico.
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLeyendo(false);
    }
  }

  async function bajarPlantilla() {
    if (!plantilla) return;
    try {
      await descargarPlantilla({
        nombre: titulo,
        cabeceras: plantilla.cabeceras,
        ejemplos: plantilla.ejemplos,
        instrucciones: plantilla.instrucciones,
      });
    } catch (e: unknown) {
      setError(`No se pudo generar la plantilla: ${String((e as Error)?.message ?? e)}`);
    }
  }

  // ── Paso 2 · perfil y mapeo ─────────────────────────────────────────────────

  function cambiarPerfil(clave: string) {
    if (!crudas) return;
    const p = perfiles.find((x) => x.clave === clave);
    setPerfilClave(p ? clave : "");
    // Volver a "— Elige el formato —" limpia el resultado: dejar los KPI de la lectura
    // anterior en pantalla haría creer que esas filas siguen listas para importarse.
    if (!p) {
      setMapa({});
      setResultado(null);
      return;
    }
    const m = mapearColumnas(crudas.cabeceras, p.campos);
    setMapa(m);
    setResultado(aplicarPerfil(crudas, p, { fecha_por_defecto: fechaPorDefecto || null }, m));
  }

  function cambiarMapeo(campo: string, col: number) {
    if (!crudas || !perfilSel) return;
    const m = { ...mapa, [campo]: col };
    setMapa(m);
    setResultado(aplicarPerfil(crudas, perfilSel, { fecha_por_defecto: fechaPorDefecto || null }, m));
  }

  /** Re-parsea con la nueva fecha: las filas sin fecha propia pasan a ser válidas en vivo. */
  function cambiarFechaPorDefecto(valor: string) {
    setFechaPorDefecto(valor);
    if (!crudas || !perfilSel) return;
    setResultado(aplicarPerfil(crudas, perfilSel, { fecha_por_defecto: valor || null }, mapa));
  }

  /**
   * `conCeldas` distingue los dos orígenes: los rechazos del PASO 2 traen la fila
   * original en `raw` y se exportan con todas las columnas del archivo; los del PASO 3
   * vienen del servidor sin `raw`, así que exportarlos contra las cabeceras del archivo
   * produciría una columna vacía por cada cabecera. Esos van solo FILA + MOTIVO.
   */
  async function bajarRechazos(errores: FilaError[], conCeldas = true) {
    try {
      await descargarRechazos({
        nombre: nombreArchivo || titulo,
        cabeceras: conCeldas ? (crudas?.cabeceras ?? []).map((c) => String(c ?? "")) : [],
        errores,
      });
    } catch (e: unknown) {
      setError(`No se pudieron descargar los rechazos: ${String((e as Error)?.message ?? e)}`);
    }
  }

  // ── Paso 3 · subida ─────────────────────────────────────────────────────────

  async function importar() {
    if (!perfilSel || !resultado || !resultado.ok.length) return;
    setPaso(3);
    setSubiendo(true);
    setProgreso(0);
    setError(null);
    setResumen(null);

    // Se declaran FUERA del try: si una tanda falla a mitad de camino, las anteriores ya
    // escribieron en la base y hay que poder informarlo desde el catch. Callarlo sería
    // lo peor que puede hacer este modal: el usuario ve "error", vuelve a subir el mismo
    // archivo y duplica todo lo que sí había entrado.
    const acumulado: ResumenImportacion = {
      perfil: perfilSel.clave,
      destino: "",
      leidas: 0,
      creadas: 0,
      actualizadas: 0,
      omitidas: 0,
      errores: [],
    };
    let tandasEscritas = 0;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión para importar.");

      const { data: fila } = await supabase
        .from("usuarios")
        .select("nombre")
        .eq("id", session.user.id)
        .maybeSingle();
      const usuarioNombre =
        (fila as { nombre?: string | null } | null)?.nombre || session.user.email || session.user.id;

      const tandas: FilaImportada[][] = [];
      for (let i = 0; i < resultado.ok.length; i += TANDA) tandas.push(resultado.ok.slice(i, i + TANDA));

      for (let t = 0; t < tandas.length; t++) {
        setTandaMsg(tandas.length > 1 ? `Tanda ${t + 1} de ${tandas.length}…` : "Subiendo…");

        const res = await fetch("/api/finanzas/importar", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          // `extras` va primero para que nunca pueda pisar el perfil ni las filas.
          body: JSON.stringify({
            ...(extras ?? {}),
            perfil: perfilSel.clave,
            filas: tandas[t],
            archivo_nombre: nombreArchivo,
            usuario_nombre: usuarioNombre,
          }),
        });

        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = (json as { error?: string } | null)?.error ?? `Error HTTP ${res.status}`;
          throw new Error(tandas.length > 1 ? `Tanda ${t + 1} de ${tandas.length}: ${msg}` : msg);
        }
        const r = json as ResumenImportacion;

        acumulado.destino = r.destino || acumulado.destino;
        acumulado.leidas += r.leidas ?? 0;
        acumulado.creadas += r.creadas ?? 0;
        acumulado.actualizadas += r.actualizadas ?? 0;
        acumulado.omitidas += r.omitidas ?? 0;
        // El servidor numera cada fila dentro de la tanda que recibió; se desplaza para
        // que dos tandas no informen ambas "Fila 2" y el número siga siendo ubicable.
        for (const e of r.errores ?? []) {
          acumulado.errores.push({ fila: e.fila != null ? e.fila + t * TANDA : undefined, motivo: e.motivo });
        }
        // Cada tanda queda registrada por separado en importaciones_finanzas; se guarda
        // la última, que es la que deja el id más reciente para deshacer.
        if (r.importacion_id != null) acumulado.importacion_id = r.importacion_id;

        tandasEscritas++;
        setProgreso(Math.round(((t + 1) / tandas.length) * 100));
      }

      setResumen(acumulado);
      onImportado?.(acumulado);
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      if (tandasEscritas > 0) {
        // Hubo escritura parcial: se muestra el resumen de lo que SÍ entró y se avisa al
        // padre para que refresque, o su lista quedaría desactualizada mostrando datos
        // que ya existen en la base.
        setError(
          `${msg} — La carga se cortó a medio camino: ${acumulado.creadas.toLocaleString("es-PE")} fila(s) YA se escribieron en la base. ` +
            `No vuelvas a subir el archivo completo sin quitar antes lo que ya entró.`
        );
        setResumen(acumulado);
        onImportado?.(acumulado);
      } else {
        setError(msg);
      }
    } finally {
      setSubiendo(false);
      setTandaMsg("");
    }
  }

  // ── Derivados de la vista previa ────────────────────────────────────────────

  const previa = useMemo(() => (resultado?.ok ?? []).slice(0, 8), [resultado]);

  const columnasPrevia = useMemo(() => {
    if (!previa.length) return [] as string[];
    // Se muestran las claves del perfil que traen algún dato: sin esto, media tabla
    // serían columnas de ceros (adelantos, igv) y no cabrían las que importan.
    return Object.keys(previa[0])
      .filter((k) => previa.some((f) => f[k] != null && f[k] !== "" && f[k] !== 0))
      .slice(0, 7);
  }, [previa]);

  const puntajeActual = ranking.find((r) => r.clave === perfilClave)?.puntaje ?? 0;
  const cabeceras = useMemo(() => (crudas?.cabeceras ?? []).map((c) => String(c ?? "")), [crudas]);

  const kpisRevision = resultado
    ? [
        { label: "Filas válidas", valor: resultado.ok.length, ...VERDE },
        { label: "Con error", valor: resultado.errores.length, ...ROJO },
        { label: "Total leídas", valor: resultado.total, color: NAVY, bg: "#eef3f8" },
      ]
    : [];

  const kpisResultado = resumen
    ? [
        { label: "Creadas", valor: resumen.creadas, ...VERDE },
        { label: "Omitidas", valor: resumen.omitidas, ...AMBAR },
        { label: "Con error", valor: resumen.errores.length, ...ROJO },
        { label: "Leídas", valor: resumen.leidas, color: NAVY, bg: "#eef3f8" },
      ]
    : [];

  function cerrar() {
    // Cerrar a media subida dejaría la carga a medio camino sin que nadie vea el
    // resultado; mientras sube, el modal no se cierra.
    if (subiendo) return;
    onCerrar();
  }

  if (!abierto) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={cerrar}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="px-6 py-4 border-b">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <h3 className="font-bold text-gray-900">{titulo}</h3>
              <p className="text-xs text-gray-400 mt-1">
                {descripcion ?? "Sube un Excel, un CSV o pega el enlace de un Google Sheet."}
              </p>
            </div>
            <div className="flex gap-1">
              {PASOS.map((p) => (
                <span
                  key={p.n}
                  className="text-[11px] font-bold px-2.5 py-1 rounded-lg"
                  style={{
                    background: paso === p.n ? NAVY : paso > p.n ? "#dcfce7" : "#f3f4f6",
                    color: paso === p.n ? "#ffffff" : paso > p.n ? "#166534" : "#9ca3af",
                  }}
                >
                  {paso > p.n ? "✓" : p.n} {p.label}
                </span>
              ))}
            </div>
          </div>

          {crudas && (
            <p className="text-xs text-gray-500 mt-3 flex items-center gap-2 flex-wrap">
              <span className="font-mono font-black text-xs text-[#0b315f]">📄 {nombreArchivo}</span>
              <span className="text-gray-300">·</span>
              <span>Hoja: <strong className="text-gray-700">{crudas.hoja}</strong></span>
              <span className="text-gray-300">·</span>
              <span>{crudas.filas.length.toLocaleString("es-PE")} filas de datos</span>
            </p>
          )}
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800">
              <span className="text-lg leading-none">⚠️</span>
              <span>{error}</span>
            </div>
          )}

          {/* ── PASO 1 · ORIGEN ───────────────────────────────────────────── */}
          {paso === 1 && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setArrastrando(true);
                }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setArrastrando(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) cargarArchivo(f);
                }}
                className="rounded-2xl border-2 border-dashed p-8 text-center transition-all"
                style={{
                  borderColor: arrastrando ? NAVY : "#e2e8f0",
                  background: arrastrando ? "#eef3f8" : "#f8fafc",
                }}
              >
                <p className="text-4xl mb-2">📥</p>
                <p className="text-sm font-bold text-gray-700">Arrastra aquí tu archivo</p>
                <p className="text-xs text-gray-400 mt-1">Excel (.xlsx, .xls) o CSV · máximo 20 000 filas</p>
                <button
                  type="button"
                  disabled={leyendo}
                  onClick={() => fileRef.current?.click()}
                  className="mt-4 px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                  style={{ background: NAVY }}
                >
                  {leyendo ? "Leyendo…" : "Elegir archivo"}
                </button>
                <input
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  className="hidden"
                  ref={fileRef}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) cargarArchivo(f);
                  }}
                />
              </div>

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-gray-100" />
                <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">o desde Google Sheets</span>
                <div className="h-px flex-1 bg-gray-100" />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                  Enlace de la hoja
                </label>
                <div className="flex flex-col md:flex-row gap-3">
                  <input
                    value={enlace}
                    onChange={(e) => setEnlace(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") cargarEnlace();
                    }}
                    placeholder="https://docs.google.com/spreadsheets/d/…"
                    className={inputCls("flex-1")}
                  />
                  <button
                    type="button"
                    disabled={leyendo || !enlace.trim()}
                    onClick={cargarEnlace}
                    className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50 disabled:opacity-60 whitespace-nowrap"
                    style={{ borderColor: NAVY, color: NAVY }}
                  >
                    {leyendo ? "Leyendo…" : "Leer hoja"}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  La hoja debe estar compartida como &ldquo;Cualquiera con el enlace · Lector&rdquo;.
                </p>
              </div>

              {plantilla && (
                <div className="px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900 flex items-center justify-between gap-3 flex-wrap">
                  <span>¿No sabes qué columnas poner? Empieza por la plantilla.</span>
                  <button
                    type="button"
                    onClick={bajarPlantilla}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border border-blue-300 bg-white hover:bg-blue-50 text-blue-900"
                  >
                    ⬇️ Descargar plantilla
                  </button>
                </div>
              )}
            </>
          )}

          {/* ── PASO 2 · REVISIÓN ─────────────────────────────────────────── */}
          {paso === 2 && crudas && (
            <>
              {/* Perfil detectado */}
              <div
                className="rounded-xl border p-4 space-y-3"
                style={{
                  background: autoDetectado ? "#f0fdfa" : "#fef9c3",
                  borderColor: autoDetectado ? "#0f766e22" : "#854d0e22",
                }}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: autoDetectado ? "#0f766e99" : "#854d0e99" }}>
                      {autoDetectado ? "Formato detectado" : "No se reconoció el formato automáticamente"}
                    </p>
                    <p className="text-sm font-black mt-0.5" style={{ color: autoDetectado ? "#0f766e" : "#854d0e" }}>
                      {perfilSel?.nombre ?? "Elige un formato"} · {Math.round(puntajeActual * 100)}% de coincidencia
                    </p>
                    {perfilSel?.descripcion && (
                      <p className="text-xs text-gray-500 mt-1">{perfilSel.descripcion}</p>
                    )}
                  </div>
                  <select
                    value={perfilClave}
                    onChange={(e) => cambiarPerfil(e.target.value)}
                    className="border rounded-xl px-4 py-2.5 text-sm bg-white"
                  >
                    <option value="">— Elige el formato —</option>
                    {ranking.map((r) => (
                      <option key={r.clave} value={r.clave}>
                        {r.nombre} ({Math.round(r.puntaje * 100)}%)
                      </option>
                    ))}
                  </select>
                </div>

                {!autoDetectado && (
                  <p className="text-xs" style={{ color: "#854d0e" }}>
                    Elige el formato correcto y corrige abajo las columnas que no calzaron. El archivo se
                    vuelve a leer con cada cambio.
                  </p>
                )}
              </div>

              {/* KPIs */}
              {resultado && (
                <section className="grid grid-cols-3 gap-3">
                  {kpisRevision.map((k) => (
                    <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
                      <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
                      <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>
                        {k.valor.toLocaleString("es-PE")}
                      </p>
                    </div>
                  ))}
                </section>
              )}

              {/* Fecha de referencia · solo si el formato admite filas sin fecha propia */}
              {perfilSel?.pideFechaPorDefecto && (
                <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center gap-3 text-sm text-amber-800">
                  <span className="font-bold">📅 Fecha de referencia</span>
                  <input
                    type="date"
                    value={fechaPorDefecto}
                    onChange={(e) => cambiarFechaPorDefecto(e.target.value)}
                    className="border border-amber-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                  />
                  <span className="text-xs text-amber-700 flex-1 min-w-[240px]">
                    Se usa solo en las filas que no traen ninguna fecha propia (recibos por honorarios
                    con el periodo escrito a mano). El resto conserva la suya.
                  </span>
                </section>
              )}

              {/* Mapeo manual */}
              {perfilSel && (
                <details className="bg-white rounded-2xl border shadow-sm overflow-hidden" open={!autoDetectado}>
                  <summary className="px-4 py-3 text-sm font-bold text-gray-700 cursor-pointer select-none hover:bg-gray-50">
                    🔗 Mapeo de columnas
                    <span className="text-gray-400 font-medium"> · qué columna del archivo alimenta cada campo</span>
                  </summary>
                  <div className="overflow-x-auto border-t" style={{ borderColor: "#f1f5f9" }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                          <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">Campo del ERP</th>
                          <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">Columna del archivo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {perfilSel.campos.map((campo) => {
                          const col = mapa[campo.campo] ?? -1;
                          const faltaObligatorio = campo.requerido && col < 0;
                          return (
                            <tr key={campo.campo} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                              <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">
                                {etiquetaCampo(campo.campo)}
                                {campo.requerido && (
                                  <span
                                    className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-lg"
                                    style={faltaObligatorio ? ROJO : { background: "#f3f4f6", color: "#4b5563" }}
                                  >
                                    obligatorio
                                  </span>
                                )}
                              </td>
                              <td className="p-3">
                                <select
                                  value={col}
                                  onChange={(e) => cambiarMapeo(campo.campo, Number(e.target.value))}
                                  className="border rounded-xl px-3 py-2 text-sm w-full max-w-sm"
                                  style={faltaObligatorio ? { borderColor: "#991b1b" } : undefined}
                                >
                                  <option value={-1}>— Sin asignar —</option>
                                  {cabeceras.map((h, i) => (
                                    <option key={`${i}-${h}`} value={i}>
                                      {letraColumna(i)} · {h || "(sin cabecera)"}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Vista previa */}
              {perfilSel && (
                <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b text-sm font-bold text-gray-700" style={{ borderColor: "#f1f5f9" }}>
                    👀 Vista previa
                    <span className="text-gray-400 font-medium"> · primeras {previa.length} filas válidas</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                          {columnasPrevia.map((c) => (
                            <th key={c} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                              {etiquetaCampo(c)}
                            </th>
                          ))}
                          {!columnasPrevia.length && (
                            <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Vista previa</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {previa.map((f, i) => (
                          <tr key={i} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                            {columnasPrevia.map((c) => (
                              <td key={c} className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">
                                {fmtCelda(c, f[c], String(f.moneda ?? "PEN"))}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {!previa.length && (
                          <tr>
                            <td colSpan={Math.max(1, columnasPrevia.length)} className="p-10 text-center text-gray-400">
                              <p className="text-3xl mb-2">🫙</p>
                              <p>Ninguna fila pasó la validación</p>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Errores */}
              {!!resultado?.errores.length && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-2">
                  <p className="font-bold">
                    {resultado.errores.length.toLocaleString("es-PE")} fila(s) no se pueden importar
                  </p>
                  <ul className="space-y-1 text-xs">
                    {resultado.errores.slice(0, 10).map((e, i) => (
                      <li key={i}>
                        <strong>Fila {e.fila}:</strong> {e.motivo}
                      </li>
                    ))}
                  </ul>
                  {resultado.errores.length > 10 && (
                    <p className="text-xs text-red-600">… y {resultado.errores.length - 10} más.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => bajarRechazos(resultado.errores)}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border border-red-200 bg-white hover:bg-red-50 text-red-700"
                  >
                    ⬇️ Descargar filas rechazadas
                  </button>
                </div>
              )}
            </>
          )}

          {/* ── PASO 3 · RESULTADO ────────────────────────────────────────── */}
          {paso === 3 && (
            <>
              {subiendo && (
                <div className="space-y-3">
                  <p className="text-sm font-bold text-gray-700">{tandaMsg || "Subiendo…"}</p>
                  <div className="h-3 rounded-full overflow-hidden" style={{ background: "#eef3f8" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${Math.max(4, progreso)}%`, background: NAVY }}
                    />
                  </div>
                  <p className="text-xs text-gray-400">
                    No cierres esta ventana: la carga se está escribiendo en la base de datos.
                  </p>
                </div>
              )}

              {resumen && (
                <>
                  <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {kpisResultado.map((k) => (
                      <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
                        <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
                        <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>
                          {k.valor.toLocaleString("es-PE")}
                        </p>
                      </div>
                    ))}
                  </section>

                  <p className="text-xs text-gray-400">
                    Destino: <strong className="font-mono font-black text-xs text-[#0b315f]">{resumen.destino || "—"}</strong>
                    {resumen.actualizadas > 0 && <> · {resumen.actualizadas.toLocaleString("es-PE")} registro(s) contenedor creados</>}
                    {resumen.importacion_id != null && <> · importación #{resumen.importacion_id}</>}
                  </p>

                  {!!resumen.errores.length && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-2">
                      <p className="font-bold">
                        {resumen.errores.length.toLocaleString("es-PE")} incidencia(s) al escribir
                      </p>
                      <ul className="space-y-1 text-xs">
                        {resumen.errores.slice(0, 10).map((e, i) => (
                          <li key={i}>
                            <strong>{e.fila != null ? `Fila ${e.fila}` : "General"}:</strong> {e.motivo}
                          </li>
                        ))}
                      </ul>
                      {resumen.errores.length > 10 && (
                        <p className="text-xs text-red-600">… y {resumen.errores.length - 10} más.</p>
                      )}
                      <p className="text-xs text-red-600">
                        La numeración corresponde al orden de las filas válidas enviadas, no al del archivo original.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          bajarRechazos(
                            resumen.errores.map((e) => ({ fila: e.fila ?? 0, motivo: e.motivo })),
                            false
                          )
                        }
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold border border-red-200 bg-white hover:bg-red-50 text-red-700"
                      >
                        ⬇️ Descargar rechazos
                      </button>
                    </div>
                  )}

                  {/* `!error` es imprescindible: en una carga cortada a media tanda el
                      resumen existe y puede venir sin incidencias, y este banner verde
                      contradiría al banner rojo de arriba. */}
                  {!resumen.errores.length && !error && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-3 text-sm text-emerald-800">
                      <span className="text-lg leading-none">✅</span>
                      <span>La importación terminó sin incidencias.</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Pie */}
        <div className="px-6 py-4 border-t flex justify-end gap-3 flex-wrap">
          {paso === 1 && (
            <button type="button" onClick={cerrar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          )}

          {paso === 2 && (
            <>
              <button
                type="button"
                onClick={() => {
                  setPaso(1);
                  setError(null);
                }}
                className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50"
              >
                ← Otro archivo
              </button>
              <button
                type="button"
                disabled={!perfilSel || !resultado?.ok.length}
                onClick={importar}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                style={{ background: NAVY }}
              >
                Importar {resultado?.ok.length ? `${resultado.ok.length.toLocaleString("es-PE")} fila(s)` : ""}
              </button>
            </>
          )}

          {paso === 3 && (
            <>
              {!subiendo && !resumen && (
                <button
                  type="button"
                  onClick={() => setPaso(2)}
                  className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50"
                >
                  ← Volver a la revisión
                </button>
              )}
              <button
                type="button"
                disabled={subiendo}
                onClick={cerrar}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                style={{ background: NAVY }}
              >
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
