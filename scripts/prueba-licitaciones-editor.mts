// scripts/prueba-licitaciones-editor.mts — Matriz del EDITOR de /licitaciones/[id] (lo que no es pantalla):
//   npx tsx scripts/prueba-licitaciones-editor.mts
//
// Monta los hooks con React DE VERDAD (react-dom/client sobre un DOM mínimo: no hay jsdom en el repo) y
// con temporizadores reales, y una base falsa inyectada con fijarClienteDatos (la misma puerta que usa
// prueba-licitaciones-datos.mts). Fija:
//  1 · el guardado automático (useEdicionLicitacion): antirrebote, solo lo tocado, nunca dos a la vez,
//      el encolado manda lo que cambió durante el vuelo, se adopta lo normalizado por la base, el
//      conflicto DETIENE el automático, recargar lo reanuda, un error no se reintenta en bucle,
//      archivada = solo lectura, y al desmontar se manda lo pendiente;
//  2 · la lectura con IA (useLecturaIA): guarda antes, estima, el confirm nombra el costo, lee; cancelar
//      no lee; sin guardar no se gasta nada; tasa con su plazo; 401/403 nombran el módulo; 504 sin JSON;
//      RETOMAR: al montar se pregunta por el último análisis guardado (ultimoAnalisis) y se ofrece; se carga
//      como uno recién leído (mismo id); las etiquetas A1… cuentan solo lo LEÍDO (un protegido no corre la
//      cuenta de los demás en silencio: recién leído, sin saber cuál se omitió, no se afirma ninguna); si
//      la consulta falla no se ofrece retomar y nada se rompe;
//  3 · el editor de reglas: ida y vuelta regla → borrador → regla en los 16 tipos (= normalizarRegla)
//      y un borrador incompleto nunca entrega una regla;
//  4 · las anclas: el elemento y, de respaldo, su panel (contrato-editor.ts).
// La espera del antirrebote es real (~25 s en total).
import { createRequire } from "node:module";
import type { Licitacion, Regla } from "../lib/licitaciones/tipos";
import type { Edicion } from "../components/licitaciones/editor/useEdicionLicitacion";
import type { TiendaIA } from "../components/licitaciones/editor/analisis-ia";

// lib/supabase.ts crea el cliente al importarse (vía lib/fetch-erp): sin URL lanza. No se llama a la red.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://ejemplo.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "x";
// Todo se carga por require (el mismo camino que siguen los componentes): con import ESM la matriz y
// el hook tendrían DOS instancias de lib/licitaciones/datos y la base falsa no llegaría al hook.
const requerir = createRequire(import.meta.url);
const { act, createElement } = requerir("react") as typeof import("react");
const { createRoot } = requerir("react-dom/client") as typeof import("react-dom/client");
const { fijarClienteDatos } = requerir("../lib/licitaciones/datos.ts") as typeof import("../lib/licitaciones/datos");
const { docVacio, normalizarRegla } = requerir("../lib/licitaciones/normalizar.ts") as typeof import("../lib/licitaciones/normalizar");
const { useEdicionLicitacion, RETRASO_GUARDADO_MS } = requerir("../components/licitaciones/editor/useEdicionLicitacion.ts") as typeof import("../components/licitaciones/editor/useEdicionLicitacion");
const { useLecturaIA, resultadoDeGuardado } = requerir("../components/licitaciones/editor/analisis-ia.tsx") as typeof import("../components/licitaciones/editor/analisis-ia");
const { borradorDe, reglaDeBorrador } = requerir("../components/licitaciones/editor/bases/EditorRegla.tsx") as typeof import("../components/licitaciones/editor/bases/EditorRegla");
const { candidatosAncla } = requerir("../components/licitaciones/editor/navegacion.ts") as typeof import("../components/licitaciones/editor/navegacion");

// ── Entorno mínimo ──
const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
const doc0 = { nodeType: 9, addEventListener() {}, removeEventListener() {}, defaultView: null, activeElement: null };
g.window = globalThis; g.HTMLIFrameElement = class {}; g.document = doc0;
const contenedor = () => ({ nodeType: 1, ownerDocument: doc0, addEventListener() {}, removeEventListener() {}, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml" }) as unknown as Element;

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ══ 1 · Guardado ═══════════════════════════════════════════════════════════════
type Q = { tabla: string; op: string; patch?: Record<string, unknown>; filtros: [string, unknown][]; una?: boolean };
const fila: Record<string, unknown> = {
  id: 9, nombre: "Lic", cliente_id: null, cliente_nombre: "C", codigo: null, objeto: null, atencion: null, fecha_consultas: null,
  fecha_presentacion: null, hora_presentacion: null, fecha_inicio_servicio: null, plazo_meses: null, estado: "preparacion",
  archivada: false, doc: docVacio(() => crypto.randomUUID()), version: 1, creado_por: null, creado_en: "",
  actualizado_por: "u-otra", actualizado_en: "2026-10-24T15:00:00Z",
};
const llamadas: { patch: Record<string, unknown>; version: unknown }[] = [];
let enVuelo = 0, maxEnVuelo = 0, retraso = 0;
// licitacion_analisis: la fila del «último análisis» (null = no hay) o un error de lectura.
let analisisFila: Record<string, unknown> | null = null, analisisError = false, nConsultasAnalisis = 0;
async function ejecutar(st: Q) {
  if (st.tabla === "usuarios") return { data: [{ id: "u-otra", nombre: "Ana" }], error: null };
  if (st.tabla === "licitacion_analisis") {
    nConsultasAnalisis++;
    if (analisisError) return { data: null, error: { message: "permission denied for table licitacion_analisis", code: "42501" } };
    return { data: st.una ? analisisFila : analisisFila ? [analisisFila] : [], error: null };
  }
  if (st.op === "update") {
    enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
    await espera(retraso);
    enVuelo--;
    const v = st.filtros.find((f) => f[0] === "version")?.[1];
    llamadas.push({ patch: st.patch!, version: v });
    if (v !== fila.version) return { data: [], error: null };
    Object.assign(fila, st.patch, { version: Number(fila.version) + 1, actualizado_por: "u-yo" });
    if (typeof fila.nombre === "string") fila.nombre = fila.nombre.trim();   // la base «normaliza»
    return { data: [{ ...fila }], error: null };
  }
  return { data: st.una ? { ...fila } : [{ ...fila }], error: null };
}
function builder(tabla: string) {
  const st: Q = { tabla, op: "select", filtros: [] };
  const b = {
    select() { return b; }, update(p: Record<string, unknown>) { st.op = "update"; st.patch = p; return b; },
    eq(k: string, v: unknown) { st.filtros.push([k, v]); return b; }, in() { return b; }, order() { return b; }, range() { return b; },
    not() { return b; }, limit() { return b; },
    maybeSingle() { st.una = true; return b; },
    then(res: (x: unknown) => unknown, rej: (e: unknown) => unknown) { return ejecutar(st).then(res, rej); },
  };
  return b;
}
fijarClienteDatos({ from: (t: string) => builder(t) });

let ed: Edicion | null = null;
function SondaEdicion() { ed = useEdicionLicitacion(); return null; }
const E = () => ed as Edicion;

sec("1 · guardado automático");
{
  const root = createRoot(contenedor());
  await act(async () => { root.render(createElement(SondaEdicion)); });
  await act(async () => { E().cargar({ ...(fila as unknown as Licitacion) }); });
  check(E().fase === "guardado" && !E().pendiente, "al cargar: guardado, nada pendiente");

  await act(async () => { E().cambiarColumnas({ nombre: "Lic A " }); E().cambiarColumnas({ nombre: "Lic AB " }); });
  check(E().fase === "sin_guardar" && E().pendiente, "tras cambiar: sin guardar");
  await act(async () => { await espera(RETRASO_GUARDADO_MS - 600); });
  check(llamadas.length === 0, "antes del antirrebote no se guarda");
  await act(async () => { await espera(900); });
  check(llamadas.length === 1 && Object.keys(llamadas[0].patch).join() === "nombre" && llamadas[0].version === 1, "un guardado, solo con la columna tocada, con la versión leída");
  check(E().fase === "guardado" && E().lic?.nombre === "Lic AB" && E().guardada?.version === 2, "se adopta lo normalizado por la base y la versión nueva");

  retraso = 400;
  await act(async () => { E().cambiarDoc((d) => ({ ...d, consultas: [...d.consultas, { id: "c1", numero: null, pregunta: "P", respuesta: "", incorporacion: "", cita: null }] })); });
  let p1!: Promise<boolean>;
  await act(async () => { p1 = E().guardarAhora(); await espera(50); });
  check(E().fase === "guardando", "guardando…");
  await act(async () => { E().cambiarColumnas({ codigo: "X-1" }); });
  let p2!: Promise<boolean>;
  await act(async () => { p2 = E().guardarAhora(); });
  const res = { r2: false, r3: true };
  await act(async () => { [, res.r2] = await Promise.all([p1, p2]); });
  check(maxEnVuelo === 1, "nunca dos guardados a la vez");
  check(llamadas.length === 3 && Object.keys(llamadas[1].patch).join() === "doc" && Object.keys(llamadas[2].patch).join() === "codigo", "el encolado manda solo lo que cambió durante el vuelo");
  check(res.r2 && !E().pendiente && E().fase === "guardado" && E().guardada?.version === 4, "guardarAhora espera al encolado y deja todo guardado");

  retraso = 0;
  fila.version = 10; fila.actualizado_por = "u-otra";
  await act(async () => { E().cambiarColumnas({ objeto: "Nuevo objeto" }); });
  await act(async () => { res.r3 = await E().guardarAhora(); });
  check(!res.r3 && E().fase === "conflicto" && E().conflicto?.version === 10 && E().conflicto?.por === "Ana", "conflicto: con quién y qué versión");
  const antes = llamadas.length;
  await act(async () => { E().cambiarColumnas({ objeto: "Otro" }); });
  await act(async () => { await espera(RETRASO_GUARDADO_MS + 300); });
  check(llamadas.length === antes && E().pendiente, "con conflicto no se guarda más (lo local queda pendiente)");

  await act(async () => { E().cargar({ ...(fila as unknown as Licitacion) }); });
  check(E().fase === "guardado" && !E().pendiente && !E().conflicto, "recargar descarta lo local y quita el conflicto");
  await act(async () => { E().cambiarColumnas({ atencion: "Comité" }); });
  await act(async () => { await espera(RETRASO_GUARDADO_MS + 300); });
  check(llamadas.length === antes + 1 && llamadas[llamadas.length - 1].version === 10 && E().fase === "guardado", "tras recargar, el automático vuelve a guardar");

  await act(async () => { E().cambiarColumnas({ nombre: "  " }); });
  await act(async () => { await espera(RETRASO_GUARDADO_MS + 300); });
  check(E().fase === "error" && /nombre/.test(E().error ?? ""), "error en castellano (falta el nombre)");
  const n5 = llamadas.length;
  await act(async () => { await espera(RETRASO_GUARDADO_MS + 300); });
  check(llamadas.length === n5, "un error no se reintenta en bucle");
  await act(async () => { E().cambiarColumnas({ nombre: "Lic C" }); });
  await act(async () => { await espera(RETRASO_GUARDADO_MS + 300); });
  check(E().fase === "guardado" && fila.nombre === "Lic C", "el siguiente cambio vuelve a intentar y guarda");

  await act(async () => { E().ajustarGuardada((l) => ({ ...l, archivada: true })); });
  await act(async () => { E().cambiarColumnas({ codigo: "NO" }); });
  check(E().soloLectura && E().lic?.codigo !== "NO" && E().fase === "solo_lectura", "archivada: solo lectura, no acepta cambios");
  await act(async () => { E().ajustarGuardada((l) => ({ ...l, archivada: false })); });

  const n7 = llamadas.length;
  await act(async () => { E().cambiarColumnas({ codigo: "SALIDA" }); });
  await act(async () => { root.unmount(); await espera(100); });
  check(llamadas.length === n7 + 1 && fila.codigo === "SALIDA", "al salir de la pantalla se manda lo pendiente");
}

// ══ 2 · Lectura con IA ═════════════════════════════════════════════════════════
sec("2 · lectura con IA");
{
  const pedidos: Record<string, unknown>[] = [];
  let respuestas: { status: number; cuerpo: unknown; sinJson?: boolean }[] = [];
  g.fetch = async (_u: string, o: { body: string }) => {
    pedidos.push(JSON.parse(o.body));
    const r = respuestas.shift()!;
    return { status: r.status, json: async () => { if (r.sinJson) throw new Error("no json"); return r.cuerpo; } };
  };
  let confirmar = true, textoConfirm = "";
  g.confirm = (t: string) => { textoConfirm = t; return confirmar; };
  let guardado = true, nGuardar = 0;
  const guardarAhora = async () => { nGuardar++; return guardado; };
  let t: TiendaIA | null = null;
  function SondaIA() { t = useLecturaIA(9, guardarAhora); return null; }
  const T = () => t as TiendaIA;
  const vacioAnalisis = { concurso: {}, requisitos: [], consultas: [], estructura: [], penalidades: [], criterios: [], advertencias: [] };
  const filaAnalisis = (id: number, archivos: { id: string; nombre: string; omitido: string | null }[], costo: number | null) => ({
    id, creado_en: "2026-10-24T14:05:00Z", terminado_en: "2026-10-24T14:07:00Z", usuario_id: "u-otra",
    archivos, resultado: vacioAnalisis, avisos: [], costo_usd: costo,
  });
  const root = createRoot(contenedor());
  await act(async () => { root.render(createElement(SondaIA)); await espera(20); });
  check(nConsultasAnalisis === 1 && T().retomable.estado === "ninguno" && !T().puedeRetomar, "al montar se pregunta por el último análisis; sin ninguno, no se ofrece");

  analisisFila = filaAnalisis(5, [{ id: "b1", nombre: "Bases.pdf", omitido: null }, { id: "b2", nombre: "TDR.pdf", omitido: null }], 0.39);
  respuestas = [
    { status: 200, cuerpo: { ok: true, modo: "estimacion", tokensEntrada: 52000, paginas: 30, costoUsdMax: 1.17 } },
    { status: 200, cuerpo: { ok: true, modo: "analisis", analisisId: 5, resultado: vacioAnalisis, avisos: [], uso: { tokensEntrada: 52000, tokensSalida: 9000, costoUsd: 0.39 } } },
  ];
  await act(async () => { await T().leer(["b1", "b2"], null); });
  await act(async () => { await espera(20); });
  check(nGuardar === 1, "guarda antes de leer (el servidor lee lo guardado)");
  check(pedidos.length === 2 && pedidos[0].estimar === true && pedidos[1].estimar === false && (pedidos[1].archivo_ids as string[]).join() === "b1,b2" && pedidos[1].licitacion_id === 9, "estima y después lee, con los ids de las bases");
  check(/US\$ 1\.17/.test(textoConfirm) && /30 páginas/.test(textoConfirm), "el confirm nombra el costo máximo y las páginas");
  check(T().resultado?.analisisId === 5 && T().resultado?.origen === "lectura" && T().resultado?.archivos[1].etiqueta === "A2" && T().fase === "inactivo" && !T().aplicado, "el resultado queda en memoria con sus etiquetas A1/A2");
  check(nConsultasAnalisis === 2 && T().retomable.estado === "listo" && T().puedeRetomar, "tras leer se vuelve a preguntar: el recién leído queda como retomable");

  await act(async () => { T().descartar(); });
  check(T().resultado === null && T().puedeRetomar, "cerrar el análisis no lo pierde: sigue ofreciéndose retomarlo");
  await act(async () => { T().retomar(); });
  const rr = T().resultado;
  check(rr?.analisisId === 5 && rr?.origen === "guardado" && rr?.porNombre === "Ana" && rr?.uso.costoUsd === 0.39 && rr?.uso.tokensEntrada === null, "retomar lo carga con su id, quién lo leyó y su costo (sin tokens inventados)");
  check(rr?.archivos.map((x) => x.etiqueta).join() === "A1,A2" && rr?.archivos[0].nombre === "Bases.pdf", "retomado: etiquetas y nombres de lo leído");
  await act(async () => { T().descartar(); });

  // Un protegido: el servidor etiqueta solo lo leído (b2 pasa a ser A1).
  analisisFila = filaAnalisis(6, [{ id: "b1", nombre: "Bases.pdf", omitido: "pdf_protegido" }, { id: "b2", nombre: "TDR.pdf", omitido: null }], 0.2);
  respuestas = [
    { status: 200, cuerpo: { ok: true, modo: "estimacion", tokensEntrada: 9000, paginas: 4, costoUsdMax: 0.3 } },
    { status: 200, cuerpo: { ok: true, modo: "analisis", analisisId: 6, resultado: vacioAnalisis, avisos: [{ codigo: "archivo_omitido", detalle: "«Bases.pdf» está protegido" }], uso: { tokensEntrada: 9000, tokensSalida: 900, costoUsd: 0.2 } } },
  ];
  await act(async () => { await T().leer(["b1", "b2"], null); });
  await act(async () => { await espera(20); });
  const ro = T().resultado;
  check(ro?.analisisId === 6 && ro?.origen === "lectura" && ro?.archivos[0].etiqueta === null && ro?.archivos[0].omitido === "pdf_protegido" && ro?.archivos[1].etiqueta === "A1", "con un archivo omitido, la fila guardada dice cuál: b2 es A1 y b1 no tiene etiqueta");
  await act(async () => { T().descartar(); });

  // Si la consulta del último análisis falla: el recién leído no afirma etiquetas y no se ofrece retomar.
  analisisError = true;
  respuestas = [
    { status: 200, cuerpo: { ok: true, modo: "estimacion", tokensEntrada: 9000, paginas: 4, costoUsdMax: 0.3 } },
    { status: 200, cuerpo: { ok: true, modo: "analisis", analisisId: 7, resultado: vacioAnalisis, avisos: [{ codigo: "archivo_omitido", detalle: "«Bases.pdf» está protegido" }], uso: { tokensEntrada: 9000, tokensSalida: 900, costoUsd: 0.2 } } },
  ];
  await act(async () => { await T().leer(["b1", "b2"], null); });
  await act(async () => { await espera(20); });
  check(T().resultado?.analisisId === 7 && T().resultado?.archivos.every((x) => x.etiqueta === null) === true, "sin saber cuál se omitió, no se afirma ninguna etiqueta");
  check(T().retomable.estado === "error" && !T().puedeRetomar && T().resultado !== null, "la consulta fallida no rompe nada: solo no se ofrece retomar");
  await act(async () => { T().descartar(); });
  analisisError = false;

  const rg = resultadoDeGuardado({ id: 3, creado_en: "2026-10-24T14:00:00Z", terminado_en: null, usuario_nombre: null, archivos: [{ id: "x", nombre: "a", omitido: null }, { id: "y", nombre: "b", omitido: "pdf_ilegible" }, { id: "z", nombre: "c", omitido: null }], resultado: vacioAnalisis as never, avisos: [], costo_usd: null });
  check(rg.archivos.map((x) => x.etiqueta ?? "-").join() === "A1,-,A2" && rg.en === Date.parse("2026-10-24T14:00:00Z") && rg.uso.costoUsd === null, "resultadoDeGuardado: las etiquetas saltan al omitido; sin terminado_en usa creado_en");

  pedidos.length = 0; confirmar = false;
  respuestas = [{ status: 200, cuerpo: { ok: true, modo: "estimacion", tokensEntrada: 10, paginas: 1, costoUsdMax: null } }];
  await act(async () => { await T().leer(["b1"], "texto"); });
  check(pedidos.length === 1 && T().fase === "inactivo" && /No se pudo calcular el costo máximo/.test(textoConfirm), "cancelar no lee; sin costo calculado, lo dice");

  pedidos.length = 0; confirmar = true; guardado = false;
  await act(async () => { await T().leer(["b1"], null); });
  check(pedidos.length === 0 && T().error?.codigo === "no_guardado", "si no se pudo guardar, no se llama a la ruta");

  guardado = true;
  respuestas = [{ status: 429, cuerpo: { ok: false, codigo: "tasa", error: "Hiciste 3 lecturas…", reintentarEnSeg: 120 } }];
  await act(async () => { await T().leer(["b1"], null); });
  check(T().error?.codigo === "tasa" && (T().error?.reintentarHasta ?? 0) > Date.now() + 100_000, "tasa: el error guarda hasta cuándo esperar");

  respuestas = [{ status: 403, cuerpo: { ok: false, codigo: "sin_permiso", error: "Sin acceso." } }];
  await act(async () => { await T().leer(["b1"], null); });
  check(/módulo «Licitaciones»/.test(T().error?.texto ?? ""), "403: nombra el módulo que falta");

  respuestas = [{ status: 504, cuerpo: null, sinJson: true }];
  await act(async () => { await T().leer(["b1"], null); });
  check(T().error?.codigo === "sin_respuesta" && /se cortó/.test(T().error?.texto ?? ""), "504 sin JSON: dice que se cortó");

  const g0 = nGuardar;
  await act(async () => { await T().leer(["a", "b", "c", "d", "e", "f"], null); });
  check(nGuardar === g0 && T().error?.codigo === "entrada_invalida", "más de 5 archivos se rechaza antes de guardar o gastar");
  await act(async () => { root.unmount(); });
}

// ══ 3 · Editor de reglas ═══════════════════════════════════════════════════════
sec("3 · editor de reglas");
{
  const reglas: Regla[] = [
    { tipo: "doc_empresa", legajo: "ficha_ruc", antiguedadMaxDias: 30 },
    { tipo: "doc_empresa", legajo: "brochure", antiguedadMaxDias: null },
    { tipo: "unidad_antiguedad_max", anios: 10, referencia: "inicio_servicio" },
    { tipo: "unidad_antiguedad_max", anios: 0, referencia: "presentacion" },
    { tipo: "unidad_capacidad_min", asientos: 30, uso: "Ruta 1" },
    { tipo: "unidad_capacidad_min", asientos: 15, uso: null },
    { tipo: "unidad_doc", doc: "soat", vigenteAl: "presentacion" },
    { tipo: "unidad_fotos" },
    { tipo: "unidades_titulares_min", n: 3 },
    { tipo: "unidades_reten_min", n: 1 },
    { tipo: "conductor_licencia", categorias: ["A-IIb", "A-IIIa"] },
    { tipo: "conductor_doc", doc: "record_conductor", antiguedadMaxDias: 30 },
    { tipo: "conductores_relevo_min", n: 2 },
    { tipo: "prohibe_subcontratacion" },
    { tipo: "experiencia_anios_min", anios: 5, desde: "constitucion" },
    { tipo: "experiencia_monto_min", monto: 150000.5, moneda: "USD" },
    { tipo: "experiencia_cartas_min", n: 3 },
    { tipo: "experiencia_ventana_anios", anios: 5 },
    { tipo: "seguro", seguro: "deshonestidad", vigenteAl: "inicio_servicio" },
  ];
  for (const r of reglas) check(JSON.stringify(reglaDeBorrador(borradorDe(r)).regla) === JSON.stringify(normalizarRegla(r)), `ida y vuelta ${JSON.stringify(r)}`);
  const vacio = borradorDe(null);
  check(reglaDeBorrador(vacio).regla === null && reglaDeBorrador(vacio).falta === null, "sin tipo: sin regla y sin aviso");
  check(reglaDeBorrador({ ...vacio, tipo: "doc_empresa" }).regla === null, "doc_empresa sin legajo no entrega regla");
  check(reglaDeBorrador({ ...vacio, tipo: "unidad_capacidad_min", asientos: "0" }).falta !== null, "0 asientos no vale");
  check(reglaDeBorrador({ ...vacio, tipo: "unidad_capacidad_min", asientos: "12.5" }).regla === null, "asientos con decimales no valen");
  check(reglaDeBorrador({ ...vacio, tipo: "experiencia_monto_min", monto: "1.234,56" }).regla === null, "monto con coma decimal se rechaza (no se adivina)");
  check(reglaDeBorrador({ ...vacio, tipo: "experiencia_monto_min", monto: "150,000.00" }).regla?.tipo === "experiencia_monto_min", "monto con coma de miles se acepta");
  check(reglaDeBorrador({ ...vacio, tipo: "doc_empresa", legajo: "ficha_ruc", antig: "5000" }).regla === null, "antigüedad fuera de rango no entrega regla (no se descarta en silencio al guardar)");
  check(reglaDeBorrador({ ...vacio, tipo: "conductor_licencia" }).regla === null, "licencia sin categorías no entrega regla");
  check(reglaDeBorrador({ ...vacio, tipo: "unidad_fotos" }).regla?.tipo === "unidad_fotos", "una regla sin parámetros vale al elegirla");
}

// ══ 4 · Anclas ═════════════════════════════════════════════════════════════════
sec("4 · anclas");
check(JSON.stringify(candidatosAncla("requisito:abc")) === JSON.stringify(["requisito:abc", "requisitos"]), "un requisito cae a su panel");
check(JSON.stringify(candidatosAncla("unidad:p:12")) === JSON.stringify(["unidad:p:12", "unidades"]), "una unidad (por su clave) cae a «unidades»");
check(JSON.stringify(candidatosAncla("datos")) === JSON.stringify(["datos"]), "un panel es el panel");

console.log(`\n${ok} bien · ${fallos} mal`);
process.exit(fallos ? 1 : 0);
