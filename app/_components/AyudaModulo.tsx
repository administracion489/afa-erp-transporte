"use client";
// ============================================================
// AyudaModulo — El panel "?" de ayuda contextual del ERP.
//
// Se monta UNA sola vez en app/layout.tsx, sin props: resuelve la pantalla
// actual con usePathname() y pinta la ficha que devuelve lib/ayuda.
//
// Vive a la izquierda del botón de ELIA (él en right-5, este en right-24, los dos
// de 54 px) y se ve hermano suyo: mismo tooltip lateral, mismo panel deslizante y
// las mismas animaciones eliaIn / eliaSlide de app/globals.css.
//
// Este archivo NO contiene contenido de ayuda: todo el texto sale de
// lib/ayuda (fichas de módulo + glosario). Si una pantalla no tiene ficha,
// el botón igual abre el glosario, porque un término contable se puede
// necesitar en cualquier sitio.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ayudaDeRuta, buscarConceptos, conceptosDe, glosarioOrdenado } from "@/lib/ayuda";
import type { AyudaModulo as FichaAyuda, Concepto } from "@/lib/ayuda";

const NAVY = "#0b315f";
const GRIS = "#9ca3af";

// Rutas sin chrome del ERP (login + app del conductor, portales de cliente,
// enlaces públicos con token…). Espeja los checks de RootLayout: ahí no hay
// menú ni sesión interna, así que tampoco hay ayuda del ERP.
const RUTAS_PUBLICAS = [
  "/conductor",
  "/lector",
  "/pasajero",
  "/registro",
  "/privacidad",
  "/cliente",
  "/conductor-tercero",
  "/manuales",
  "/conformidad",
  "/proveedor",
];

function esRutaPublica(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (RUTAS_PUBLICAS.some((r) => pathname === r || pathname.startsWith(r + "/"))) return true;
  if (pathname.startsWith("/seguimiento/")) return true;
  if (process.env.NODE_ENV !== "production" && pathname.startsWith("/dev/")) return true;
  return false;
}

// ── Render de texto ──────────────────────────────────────────────────────────
// El contenido de lib/ayuda usa un markdown mínimo, y solo estas cuatro cosas
// (verificado sobre las 35 fichas y los 60 términos del glosario):
//   **negrita**            → cerca de mil tramos
//   *cursiva*              → 39 textos (nombres de estados y frases citadas)
//   saltos de línea "\n"   → párrafos; "\n\n" deja aire
//   líneas "• …" y "1. …"  → viñetas y listas numeradas dentro de un texto
// No hay code spans, ni enlaces, ni encabezados, ni negrita anidada en cursiva.
// Se parte el string y se devuelven nodos React: nada de dangerouslySetInnerHTML.

/** Convierte **negrita** y *cursiva* de UNA línea en nodos React. */
function enriquecer(linea: string, clave: string | number) {
  const nodos: React.ReactNode[] = [];
  const marcas = /\*\*(.+?)\*\*|\*([^*\n]+)\*/g;
  let desde = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = marcas.exec(linea)) !== null) {
    if (m.index > desde) nodos.push(<span key={`${clave}-t${n++}`}>{linea.slice(desde, m.index)}</span>);
    if (m[1] !== undefined) {
      nodos.push(
        <strong key={`${clave}-b${n++}`} className="font-bold" style={{ color: NAVY }}>
          {m[1]}
        </strong>
      );
    } else {
      nodos.push(
        <em key={`${clave}-i${n++}`} className="italic">
          {m[2]}
        </em>
      );
    }
    desde = m.index + m[0].length;
  }
  if (desde < linea.length) nodos.push(<span key={`${clave}-t${n++}`}>{linea.slice(desde)}</span>);
  return nodos;
}

/** "• algo" / "1. algo" → la marca separada del texto, para poder sangrar. */
function partirVineta(linea: string): { marca: string; resto: string } | null {
  const m = linea.match(/^\s*(•|-|\d+[.)])\s+(.*)$/);
  if (!m) return null;
  return { marca: m[1] === "-" ? "•" : m[1], resto: m[2] };
}

function TextoRico({ texto, className = "" }: { texto: string; className?: string }) {
  const lineas = texto.split("\n");
  return (
    <div className={className}>
      {lineas.map((linea, i) => {
        if (linea.trim() === "") return <div key={i} className="h-2" />;

        // Las viñetas y los números van con sangría francesa: si el texto da la
        // vuelta, la segunda línea no se mete debajo de la marca.
        const vineta = partirVineta(linea);
        if (vineta) {
          return (
            <div key={i} className={`flex gap-2 ${i > 0 ? "mt-1.5" : ""}`}>
              <span className="flex-shrink-0 font-semibold tabular-nums" style={{ color: "#6b7c93" }}>
                {vineta.marca}
              </span>
              <span className="min-w-0 flex-1">{enriquecer(vineta.resto, i)}</span>
            </div>
          );
        }

        return (
          <p key={i} className={i > 0 ? "mt-1.5" : ""}>
            {enriquecer(linea, i)}
          </p>
        );
      })}
    </div>
  );
}

// ── Iconos (inline, sin dependencias) ────────────────────────────────────────

function IcCerrar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IcChevron({ abierto }: { abierto: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 transition-transform ${abierto ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function IcAlerta({ className = "flex-shrink-0 mt-0.5" }: { className?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IcLupa() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="20" y1="20" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IcFlecha() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

// ── Piezas ───────────────────────────────────────────────────────────────────

function BannerAmbar({ texto }: { texto: string }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex gap-2 items-start">
      <IcAlerta />
      <TextoRico texto={texto} className="min-w-0 leading-relaxed" />
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-[#6b7c93] mb-2 px-1">{titulo}</h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/** Tarjeta plegable de un término del glosario. Se usa igual en la ficha y en el glosario. */
function TarjetaConcepto({
  concepto,
  abierta,
  onToggle,
  onIrA,
  nombreDe,
  innerRef,
}: {
  concepto: Concepto;
  abierta: boolean;
  onToggle: () => void;
  onIrA: (clave: string) => void;
  nombreDe: (clave: string) => string | null;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const relacionados = (concepto.verTambien ?? [])
    .map((c) => ({ clave: c, termino: nombreDe(c) }))
    .filter((c): c is { clave: string; termino: string } => Boolean(c.termino));

  return (
    <div ref={innerRef} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={abierta}
        className="w-full flex items-center gap-2 text-left px-4 py-3 hover:bg-[#f6f9fc] transition-colors"
      >
        <span className="flex-1 min-w-0 text-[13.5px] font-bold" style={{ color: NAVY }}>
          {concepto.termino}
        </span>
        <span className="text-[#9db4d4]">
          <IcChevron abierto={abierta} />
        </span>
      </button>

      {abierta && (
        <div className="px-4 pb-4 pt-1 space-y-2.5">
          <TextoRico texto={concepto.definicion} className="text-[13px] leading-relaxed text-[#31465f]" />

          {concepto.ejemplo && (
            <div className="rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900 px-4 py-3">
              <p className="text-[10.5px] font-extrabold uppercase tracking-wider text-blue-700 mb-1">Ejemplo</p>
              <TextoRico texto={concepto.ejemplo} className="text-[12.5px] leading-relaxed" />
            </div>
          )}

          {concepto.ojo && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-wider text-amber-700 mb-1">
                <IcAlerta className="flex-shrink-0" />
                Ojo
              </p>
              <TextoRico texto={concepto.ojo} className="text-[12.5px] leading-relaxed" />
            </div>
          )}

          {relacionados.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {relacionados.map((r) => (
                <button
                  key={r.clave}
                  type="button"
                  onClick={() => onIrA(r.clave)}
                  className="text-xs font-bold px-2.5 py-1 rounded-lg bg-[#eef4fb] text-[#1262bd] hover:bg-[#dce8f6] transition-colors"
                >
                  {r.termino}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Componente principal ─────────────────────────────────────────────────────

export default function AyudaModulo() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();

  // `rutaAbierta` es la pantalla desde la que se abrió el panel: si el usuario
  // navega (botón atrás incluido), el panel deja de estar abierto sin necesidad
  // de un efecto que haga setState.
  const [rutaAbierta, setRutaAbierta] = useState<string | null>(null);
  const [pestana, setPestana] = useState<"pantalla" | "glosario">("pantalla");
  const [busqueda, setBusqueda] = useState("");
  const [faqAbierta, setFaqAbierta] = useState<number | null>(null);
  const [pasosAbiertos, setPasosAbiertos] = useState<Record<number, boolean>>({ 0: true });
  const [terminoAbierto, setTerminoAbierto] = useState<string | null>(null);
  const [saltoTick, setSaltoTick] = useState(0);

  const cerrarRef = useRef<HTMLButtonElement | null>(null);
  const cuerpoRef = useRef<HTMLDivElement | null>(null);
  const refsTerminos = useRef<Record<string, HTMLDivElement | null>>({});
  const saltoPendiente = useRef<string | null>(null);

  const ficha: FichaAyuda | null = useMemo(() => ayudaDeRuta(pathname), [pathname]);
  const publica = esRutaPublica(pathname);

  const conceptosFicha = useMemo(() => (ficha ? conceptosDe(ficha) : []), [ficha]);
  const todos = useMemo(() => glosarioOrdenado(), []);
  const resultados = useMemo(() => buscarConceptos(busqueda), [busqueda]);
  const nombreDe = useCallback(
    (clave: string) => todos.find((c) => c.clave === clave)?.termino ?? null,
    [todos]
  );

  const abierto = rutaAbierta === pathname;
  const cerrar = useCallback(() => setRutaAbierta(null), []);

  function abrir() {
    setPestana(ficha ? "pantalla" : "glosario");
    setFaqAbierta(null);
    setPasosAbiertos({ 0: true });
    // El primer concepto de la pantalla queda abierto; los demás, plegados.
    // Tesorería trae 19 términos: desplegados todos, la ficha se vuelve un muro
    // y "Ver también" queda a metros de scroll.
    setTerminoAbierto(ficha ? conceptosFicha[0]?.clave ?? null : null);
    setRutaAbierta(pathname);
  }

  /** Cambiar de pestaña devuelve el cuerpo al principio: si no, se cae a media lista. */
  function cambiarPestana(id: "pantalla" | "glosario") {
    setPestana(id);
    cuerpoRef.current?.scrollTo({ top: 0 });
  }

  // Escape cierra.
  useEffect(() => {
    if (!abierto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cerrar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [abierto, cerrar]);

  // Al abrir, el foco va al botón de cerrar.
  useEffect(() => {
    if (!abierto) return;
    const id = requestAnimationFrame(() => cerrarRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [abierto]);

  // Salto a un término desde un chip "ver también": ya se abrió en el render
  // anterior, aquí solo se le hace scroll dentro del cuerpo del panel.
  useEffect(() => {
    const clave = saltoPendiente.current;
    if (!clave) return;
    saltoPendiente.current = null;
    const cont = cuerpoRef.current;
    const el = refsTerminos.current[clave];
    if (cont && el) cont.scrollTo({ top: Math.max(el.offsetTop - 12, 0), behavior: "smooth" });
  }, [saltoTick]);

  const irATermino = useCallback((clave: string) => {
    setBusqueda("");
    setPestana("glosario");
    setTerminoAbierto(clave);
    saltoPendiente.current = clave;
    setSaltoTick((t) => t + 1);
  }, []);

  function navegar(href: string) {
    setRutaAbierta(null);
    router.push(href);
  }

  // En pantallas públicas no hay ayuda del ERP. Sin ficha sí hay botón: el
  // glosario se puede necesitar en cualquier módulo.
  if (publica) return null;

  const subtitulo = ficha ? ficha.titulo : "Glosario del ERP";

  return (
    <>
      {/* ── Botón flotante · a la izquierda del de ELIA ── */}
      {!abierto && (
        <button
          type="button"
          onClick={abrir}
          aria-label={ficha ? `Ayuda de esta pantalla: ${ficha.titulo}` : "Abrir el glosario de términos del ERP"}
          title={ficha ? "Ayuda de esta pantalla" : "Glosario del ERP"}
          className="fixed bottom-5 right-24 z-40 group"
          style={{ animation: "eliaIn 0.35s ease-out" }}
        >
          <div className="relative">
            <div
              className="w-[54px] h-[54px] rounded-full flex items-center justify-center text-white font-black text-[26px] leading-none
                         shadow-[0_6px_18px_rgba(11,49,95,0.35)] border-2 border-white/25 group-hover:scale-105 transition-transform"
              style={{ background: "linear-gradient(135deg,#1a6fc4,#0b315f)" }}
            >
              ?
            </div>
            <span
              className="pointer-events-none absolute right-full mr-3 top-1/2 -translate-y-1/2 whitespace-nowrap
                         bg-[#0b2545] text-white text-[11px] font-semibold px-2.5 py-1.5 rounded-lg shadow-xl
                         opacity-0 group-hover:opacity-100 transition-opacity"
            >
              ¿Qué es todo esto? Te lo explico
            </span>
          </div>
        </button>
      )}

      {/* ── Fondo · clic fuera cierra ── */}
      {abierto && <div className="fixed inset-0 z-40 bg-[#0b2545]/25" onClick={cerrar} aria-hidden="true" />}

      {/* ── Panel ── */}
      {abierto && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ficha ? `Ayuda · ${ficha.titulo}` : "Glosario del ERP"}
          className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] flex flex-col bg-[#f6f9fc] shadow-2xl border-l border-[#E4E7ED]"
          style={{ animation: "eliaSlide 0.28s cubic-bezier(0.16,1,0.3,1)" }}
        >
          {/* Cabecera fija */}
          <div className="flex-shrink-0">
            <div className="flex items-center gap-3 px-6 py-4 border-b bg-gradient-to-r from-[#0c2d52] to-[#0b315f]">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-[18px] flex-shrink-0 border border-white/20"
                style={{ background: "rgba(255,255,255,0.12)" }}
              >
                ?
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-extrabold text-[15px] leading-tight tracking-tight">Ayuda</p>
                <p className="text-[10.5px] leading-tight mt-0.5 text-[#9db4d4] truncate">{subtitulo}</p>
              </div>
              <button
                ref={cerrarRef}
                type="button"
                onClick={cerrar}
                aria-label="Cerrar la ayuda"
                title="Cerrar (Esc)"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <IcCerrar />
              </button>
            </div>

            {/* Pestañas */}
            {ficha && (
              <div className="flex gap-5 px-6 bg-white border-b">
                {(
                  [
                    ["pantalla", "Esta pantalla"],
                    ["glosario", "Glosario"],
                  ] as const
                ).map(([id, etiqueta]) => {
                  const activa = pestana === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => cambiarPestana(id)}
                      className="py-3 text-[13px] font-bold border-b-2 -mb-px transition-colors"
                      style={{
                        borderColor: activa ? NAVY : "transparent",
                        color: activa ? NAVY : GRIS,
                      }}
                    >
                      {etiqueta}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cuerpo con scroll interno */}
          <div ref={cuerpoRef} className="flex-1 overflow-y-auto relative px-4 py-4 space-y-5">
            {/* ═══ ESTA PANTALLA ═══ */}
            {pestana === "pantalla" && ficha && (
              <>
                <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
                  <h2 className="text-[15.5px] font-extrabold leading-snug" style={{ color: NAVY }}>
                    {ficha.titulo}
                  </h2>
                  <TextoRico texto={ficha.resumen} className="mt-2 text-[13px] leading-relaxed text-[#31465f]" />
                </div>

                {ficha.paraQueSirve.length > 0 && (
                  <Seccion titulo="Para qué sirve">
                    <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
                      <ul className="space-y-2">
                        {ficha.paraQueSirve.map((p, i) => (
                          <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed text-[#31465f]">
                            <span className="mt-[7px] w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#2f8ee9" }} />
                            <span className="min-w-0">{enriquecer(p, i)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Seccion>
                )}

                {ficha.comoHacer && ficha.comoHacer.length > 0 && (
                  <Seccion titulo="Cómo se hace">
                    {ficha.comoHacer.map((c, i) => {
                      const ab = Boolean(pasosAbiertos[i]);
                      return (
                        <div key={i} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                          <button
                            type="button"
                            aria-expanded={ab}
                            onClick={() => setPasosAbiertos((prev) => ({ ...prev, [i]: !prev[i] }))}
                            className="w-full flex items-center gap-2 text-left px-4 py-3 hover:bg-[#f6f9fc] transition-colors"
                          >
                            <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-[#eef4fb] text-[#1262bd] flex-shrink-0">
                              {c.pasos.length} {c.pasos.length === 1 ? "paso" : "pasos"}
                            </span>
                            <span className="flex-1 min-w-0 text-[13.5px] font-bold" style={{ color: NAVY }}>
                              {c.titulo}
                            </span>
                            <span className="text-[#9db4d4]">
                              <IcChevron abierto={ab} />
                            </span>
                          </button>
                          {ab && (
                            <div className="px-4 pb-4 space-y-3">
                              <ol className="space-y-2">
                                {c.pasos.map((p, j) => (
                                  <li key={j} className="flex gap-2.5 text-[13px] leading-relaxed text-[#31465f]">
                                    <span
                                      className="flex-shrink-0 w-5 h-5 rounded-full text-white text-[10.5px] font-bold flex items-center justify-center mt-[1px]"
                                      style={{ background: NAVY }}
                                    >
                                      {j + 1}
                                    </span>
                                    <span className="min-w-0">{enriquecer(p, j)}</span>
                                  </li>
                                ))}
                              </ol>
                              {c.advertencia && <BannerAmbar texto={c.advertencia} />}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </Seccion>
                )}

                {ficha.faqs.length > 0 && (
                  <Seccion titulo="Preguntas frecuentes">
                    {ficha.faqs.map((f, i) => {
                      const ab = faqAbierta === i;
                      return (
                        <div key={i} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                          <button
                            type="button"
                            aria-expanded={ab}
                            onClick={() => setFaqAbierta(ab ? null : i)}
                            className="w-full flex items-start gap-2 text-left px-4 py-3 hover:bg-[#f6f9fc] transition-colors"
                          >
                            <span className="flex-1 min-w-0 text-[13px] font-bold leading-snug" style={{ color: NAVY }}>
                              {f.pregunta}
                            </span>
                            <span className="text-[#9db4d4] mt-0.5">
                              <IcChevron abierto={ab} />
                            </span>
                          </button>
                          {ab && (
                            <div className="px-4 pb-4 pt-0.5">
                              <TextoRico texto={f.respuesta} className="text-[13px] leading-relaxed text-[#31465f]" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </Seccion>
                )}

                {conceptosFicha.length > 0 && (
                  <Seccion titulo="Qué significa cada palabra de esta pantalla">
                    {conceptosFicha.map((c) => (
                      <TarjetaConcepto
                        key={c.clave}
                        concepto={c}
                        abierta={terminoAbierto === c.clave}
                        onToggle={() => setTerminoAbierto(terminoAbierto === c.clave ? null : c.clave)}
                        onIrA={irATermino}
                        nombreDe={nombreDe}
                      />
                    ))}
                  </Seccion>
                )}

                {ficha.relacionadas && ficha.relacionadas.length > 0 && (
                  <Seccion titulo="Ver también">
                    <div className="bg-white rounded-2xl border shadow-sm overflow-hidden divide-y">
                      {ficha.relacionadas.map((r) => (
                        <button
                          key={r.href}
                          type="button"
                          onClick={() => navegar(r.href)}
                          className="w-full flex items-center gap-2.5 text-left px-4 py-3 hover:bg-[#f6f9fc] transition-colors text-[13px] font-semibold"
                          style={{ color: "#1262bd" }}
                        >
                          <span className="flex-1 min-w-0">{r.etiqueta}</span>
                          <IcFlecha />
                        </button>
                      ))}
                    </div>
                  </Seccion>
                )}
              </>
            )}

            {/* ═══ GLOSARIO ═══ */}
            {(pestana === "glosario" || !ficha) && (
              <>
                <div className="rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900 px-4 py-3">
                  <p className="text-[12.5px] leading-relaxed">
                    Cada término se explica una sola vez y quiere decir lo mismo en todo el ERP. Escribe una palabra y
                    salen los términos que la mencionan.
                  </p>
                </div>

                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9db4d4] pointer-events-none">
                    <IcLupa />
                  </span>
                  <input
                    type="text"
                    autoComplete="off"
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                    placeholder="Busca una palabra: detracción, rendición, saldo…"
                    aria-label="Buscar un término en el glosario"
                    className="w-full rounded-2xl border bg-white shadow-sm pl-10 pr-4 py-2.5 text-[13px] text-[#31465f]
                               placeholder:text-[#9ca3af] outline-none focus:border-[#2f8ee9] transition-colors"
                  />
                </div>

                <p className="text-[11px] font-bold text-[#6b7c93] px-1 -mt-2">
                  {resultados.length} {resultados.length === 1 ? "término" : "términos"}
                  {busqueda.trim() ? " encontrados" : " en el glosario"}
                </p>

                {resultados.length === 0 ? (
                  <div className="bg-white rounded-2xl border shadow-sm px-5 py-6 text-center">
                    <p className="text-[13px] text-[#6b7c93] leading-relaxed">
                      Aquí no hay ningún término que diga eso. Prueba con una palabra suelta: detracción, saldo,
                      conciliación, rendición.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {resultados.map((c) => (
                      <TarjetaConcepto
                        key={c.clave}
                        concepto={c}
                        abierta={terminoAbierto === c.clave}
                        onToggle={() => setTerminoAbierto(terminoAbierto === c.clave ? null : c.clave)}
                        onIrA={irATermino}
                        nombreDe={nombreDe}
                        innerRef={(el) => {
                          refsTerminos.current[c.clave] = el;
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="h-2" />
          </div>
        </div>
      )}
    </>
  );
}
