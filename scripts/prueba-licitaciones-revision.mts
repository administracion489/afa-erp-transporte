// scripts/prueba-licitaciones-revision.mts — Matriz del CEREBRO del módulo Licitaciones: normalización,
// reglas, hallazgos, lo que se imprime y la plantilla base.
//   npx tsx scripts/prueba-licitaciones-revision.mts
//
// Lo que fija, y por qué:
//  1. El caso MASS LITERAL (la propuesta real): tres placas tercerizadas en un concurso que prohíbe
//     subcontratar, una placa que no existe en el ERP, «flota y personal propios» en el texto y una R.D.
//     que no es la del perfil. Son las contradicciones que el dueño pidió que el sistema advierta.
//  2. La tabla de `final` manual × regla, y cuándo se contradicen.
//  3. Una fuente que no se pudo leer NUNCA acusa «falta» (barrido de fuentes caídas).
//  4. normalizarDoc es idempotente sobre basura variada (y recorta, y no lanza).
//  5. Cada código del catálogo tiene título, arreglo y dónde.
//  6. Legajo (antiguo, sin archivo, vencido), documentos de unidad (vencido, vence antes del inicio,
//     Drive), licencia que no alcanza, experiencia por moneda, texto de otra licitación.
//  7. Lo que se imprime (resolverDocumento / resolverExpediente) y la plantilla base sin cifras ni nombres.
//  8. El corolario: el barrido produce las tres gravedades (un motor que nunca dijera nada no pasa).

import { normalizarDoc, docVacio, duplicarDoc, COLOR_DEFECTO } from "../lib/licitaciones/normalizar";
import { estadoLegajo, documentoVigente, TIPOS_LEGAJO, TIPOS_DOC_CONDUCTOR } from "../lib/licitaciones/legajo";
import { docsDeUnidad, resumenUnidad, resumenConductor } from "../lib/licitaciones/recursos";
import { VARIABLES, valoresVariables, resolverVariables, trozosDe, escanearTexto, mismaAutorizacion, tokensAutorizacion } from "../lib/licitaciones/texto";
import { evaluarRegla } from "../lib/licitaciones/reglas";
import { CATALOGO_HALLAZGOS, revisarLicitacion } from "../lib/licitaciones/revision";
import { resolverDocumento } from "../lib/licitaciones/documento";
import { expedientePorDefecto, resolverExpediente } from "../lib/licitaciones/expediente";
import { docDesdePlantilla } from "../lib/licitaciones/plantilla-base";
import {
  GRAVEDAD_HALLAZGO, PASOS, TIPOS_REGLA, CODIGOS_LEGAJO, CODIGOS_DOC_CONDUCTOR, TOPES_DOC,
  type CodigoHallazgo, type ContextoLicitacion, type ConductorERP, type DocLicitacion, type Experiencia,
  type FilaDocEmpresa, type FuenteContexto, type Licitacion, type Regla, type Requisito, type UnidadERP,
  type EstadoLectura, type Hallazgo,
} from "../lib/licitaciones/tipos";
import type { FilaSeguro } from "../lib/seguros";
import { readFileSync } from "node:fs";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);

let contador = 0;
const nid = () => `id-${++contador}`;
const BASE = "https://qakhcezrmpksxgiwzmvd.supabase.co";
const PUB = (bucket: string, ruta: string) => `${BASE}/storage/v1/object/public/${bucket}/${ruta}`;
process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;

const HOY = "2026-10-24";
const PRESENTA = "2026-11-03";
const INICIO = "2026-11-10";
const TODO_OK: Record<FuenteContexto, EstadoLectura> = { perfil: "ok", unidades: "ok", conductores: "ok", legajo: "ok", experiencia: "ok", seguros: "ok", personal: "ok", otras: "ok" };

// ── Fixtures ────────────────────────────────────────────────────────────────────
const emp = { id: 5, razon_social: "TRANSPORTES DEL SUR S.A.C.", ruc: "20111111111", autorizacion_mtc: "R.D. 777-2020", venc_autorizacion: "2027-12-31", estado: "activo" };
const docU = (id: number, tipo: string, venc: string | null, url: string | null, deEmpresa = false, origen: "documentos_vehiculo" | "documentos_tercero" = "documentos_tercero") =>
  ({ origen, id, tipo, canonico: null, numero: `N-${id}`, fecha_emision: null, fecha_vencimiento: venc, archivo_url: url, deEmpresa });
const unidad = (clave: `${"p" | "t"}:${number}`, placa: string, extra: Partial<UnidadERP> = {}): UnidadERP => ({
  clave, flota: clave[0] as "p" | "t", id: Number(clave.slice(2)), placa, marca: "Marca", modelo: "Modelo", anio: 2020, capacidad: 50,
  categoria: "Bus", estado: "activo", foto_externa_url: PUB("vehiculos-fotos", `${placa}-ext.jpg`), foto_interna_url: PUB("vehiculos-fotos", `${placa}-int.jpg`),
  empresa: clave[0] === "t" ? emp : null,
  docs: [
    docU(1, "SOAT", "2027-06-30", PUB("documentos", `${placa}/soat.pdf`)),
    docU(2, "Revisión Técnica (CITV)", "2027-03-31", PUB("documentos", `${placa}/citv.pdf`)),
    docU(3, "Tarjeta de Propiedad", null, PUB("documentos", `${placa}/tp.pdf`)),
  ],
  ...extra,
});
const conductor = (clave: `${"p" | "t"}:${number}`, nombre: string, cat: string, extra: Partial<ConductorERP> = {}): ConductorERP => ({
  clave, flota: clave[0] as "p" | "t", id: Number(clave.slice(2)), nombre, dni: "40000000", licencia: "Q40000000", categoria_licencia: cat,
  vencimiento_licencia: "2028-01-01", estado: "activo", empresa: null, archivos: [],
  ...(clave[0] === "p" ? { examen_medico_venc: "2027-05-01", antecedentes_venc: "2027-05-01", psicosometrico_venc: "2027-05-01" } : {}),
  ...extra,
});
const filaLeg = (id: number, categoria: string, emision: string | null, venc: string | null, url: string | null, created = "2026-10-01T10:00:00Z"): FilaDocEmpresa => ({
  id, titulo: categoria, categoria, alcance: "empresa", archivo_url: url, archivo_nombre: url ? `${categoria}.pdf` : null,
  fecha_emision: emision, fecha_vencimiento: venc, conductor_id: null, conductor_tercero_id: null, created_at: created,
});
const exp = (id: number, cliente: string, inicio: string, importe: number | null, moneda: "PEN" | "USD" = "PEN", extra: Partial<Experiencia> = {}): Experiencia => ({
  id, cliente_id: null, cliente_nombre: cliente, cliente_ruc: null, contacto_nombre: "Contacto", contacto_cargo: null, contacto_telefono: "999000111",
  contacto_email: null, objeto: "Transporte de personal", sector: null, zona: "Lima", inicio, fin: null, vigente: true,
  sustento_tipo: "carta", sustento_ref: null, sustento_fecha: null, importe, moneda, importe_incluye_igv: null,
  sustentos: [{ id: `s${id}`, url: PUB("licitaciones", `experiencia/${id}.pdf`), nombre: "carta.pdf", mime: "application/pdf", bytes: 1000, sha256: null, paginas: 1, subidoEn: "" }],
  notas: null, activo: true, ...extra,
});
const seguro = (tipo: string, venc: string | null, archivo: string | null = PUB("documentos", `seguros/${tipo}.pdf`)): FilaSeguro => ({
  clave: `poliza:1:${tipo}`, fuente: "poliza", origenId: 1, tipo, etiqueta: tipo, asegurado: { clase: "empresa", id: null, rotulo: "Empresa" },
  aseguradora: "Aseguradora", numero: "P-1", inicio: "2026-01-01", vencimiento: venc, dias: null, estado: "vigente", prima: null, cuota: null,
  archivo, editarEn: "/seguros", deAfa: true, tipos: [tipo], solicitados: 0,
});

const PERFIL = { nombre: "Empresa Demo", razon_social: "EMPRESA DEMO S.A.C.", ruc: "20999999999", direccion: "Av. Demo 1", telefono: "01-000", email: "demo@demo.pe", web: "demo.pe", autorizacion_mtc: "R.D. N° 1946-2009-MTC-15.", fecha_constitucion: "2017-03-01" };

function ctxBase(extra: Partial<ContextoLicitacion> = {}): ContextoLicitacion {
  return {
    hoy: HOY, perfil: PERFIL, unidades: {}, conductores: {}, legajo: [], experiencia: {}, seguros: [], personal: {}, otras: [],
    lecturas: { ...TODO_OK }, migraciones: { anioTercero: true, conductorTercero: true, fechaConstitucion: true }, ...extra,
  };
}
const req = (texto: string, regla: Regla | null, extra: Partial<Requisito> = {}) => ({
  id: nid(), numeral: null, texto, categoria: "otro", obligatorio: true, regla, manual: null, cumpleTexto: null, sustento: "",
  bloqueExpedienteId: null, enMatriz: true, origen: "manual", cita: null, ...extra,
});
function licDe(doc: unknown, extra: Partial<Licitacion> = {}): Licitacion {
  return {
    id: 7, nombre: "Concurso transporte", cliente_id: null, cliente_nombre: "MASS – CD Villa El Salvador", codigo: "CON-SERV19-2026",
    objeto: "Transporte de acercamiento de personal", atencion: "Ejecutivo de Compras", fecha_consultas: null,
    fecha_presentacion: PRESENTA, hora_presentacion: null, fecha_inicio_servicio: INICIO, plazo_meses: 24,
    estado: "preparacion", archivada: false, doc: normalizarDoc(doc, nid), version: 1,
    creado_por: null, creado_en: "2026-10-01T00:00:00Z", actualizado_por: null, actualizado_en: "2026-10-01T00:00:00Z", ...extra,
  };
}
const codigos = (hs: Hallazgo[]) => hs.map((h) => h.codigo);
const cuantos = (hs: Hallazgo[], c: CodigoHallazgo) => hs.filter((h) => h.codigo === c).length;

// ══ 1. Caso MASS literal ═════════════════════════════════════════════════════════
sec("1. Caso MASS: tercerizadas en un concurso sin subcontratación, una placa que no existe, «propios» y la R.D.");
{
  const ctx = ctxBase({
    unidades: { "t:101": unidad("t:101", "BVI-124"), "t:102": unidad("t:102", "VFC-962", { capacidad: 25 }), "t:103": unidad("t:103", "BUG-508") },
  });
  const rProh = req("No se permite consorcio ni subcontratación (pregunta 5)", { tipo: "prohibe_subcontratacion" }, { categoria: "legal" });
  const lic = licDe({
    requisitos: [rProh],
    unidades: [
      { clave: "t:101", codigo: "U1", rol: "titular", uso: "Ruta 2 – Zona Sur" },
      { clave: "t:102", codigo: "U2", rol: "titular", uso: "Ruta 1 – Higuereta" },
      { clave: "t:103", codigo: "U3", rol: "reten", uso: "Retén" },
      { clave: "t:104", codigo: "U4", rol: "reten", uso: "Retén" },        // BYE-133: no existe en el ERP
    ],
    secciones: [{ titulo: "Presentación", bloques: [
      { tipo: "parrafo", texto: "Servicio con flota y personal propios, sin subcontratar." },
      { tipo: "parrafo", texto: "Autorizaciones: MTC (transporte de personal) — R.D. N° 4968-2021-MTC/17.02" },
    ] }],
  });
  const rev = revisarLicitacion(lic, ctx);
  const hs = rev.hallazgos;
  check(cuantos(hs, "unidad_tercerizada_prohibida") === 3, `unidad_tercerizada_prohibida ×3 (salió ×${cuantos(hs, "unidad_tercerizada_prohibida")})`);
  check(hs.filter((h) => h.codigo === "unidad_tercerizada_prohibida").every((h) => h.requisitoId === lic.doc.requisitos[0].id), "las tres llevan el requisito de la regla");
  check(cuantos(hs, "unidad_no_existe") === 1, "unidad_no_existe (BYE-133)");
  check(cuantos(hs, "afirma_flota_propia") === 1, "afirma_flota_propia");
  check(cuantos(hs, "autorizacion_mtc_distinta") === 1, "autorizacion_mtc_distinta");
  const aut = hs.find((h) => h.codigo === "autorizacion_mtc_distinta");
  check(!!aut && aut.texto.includes("4968-2021") && aut.texto.includes("1946-2009"), "nombra las dos R.D. sin decir cuál es la correcta");
  check(aut?.gravedad === "alarma", "es alarma");
  const ev = rev.evaluaciones.find((e) => e.requisitoId === lic.doc.requisitos[0].id);
  check(ev?.final === "no_cumple" && ev.fuente === "regla", "el requisito de la regla queda no_cumple por la regla");
  check(!codigos(hs).includes("requisito_no_cumple"), "(b) un requisito CON regla no levanta requisito_no_cumple");
  // Sin terceros, «propios» no alarma.
  const licP = licDe({ ...lic.doc, unidades: [{ clave: "p:1", codigo: "U1", rol: "titular", uso: "" }] });
  const ctxP = ctxBase({ unidades: { "p:1": unidad("p:1", "AAA-111") } });
  check(!codigos(revisarLicitacion(licP, ctxP).hallazgos).includes("afirma_flota_propia"), "con flota propia, «propios» no alarma");
  // La misma R.D. con otro formato no alarma.
  check(mismaAutorizacion("4968-2021-MTC/17.02", "4968-2021"), "misma R.D. con otro formato");
  check(!mismaAutorizacion("4968-2021-MTC/17.02", "1946-2009-MTC-15"), "R.D. distintas");
  check(tokensAutorizacion("R.D. N° 1946-2009-MTC-15.")[0] === "1946-2009-MTC-15", "el punto final no es parte del número");
  const ctxSinAut = ctxBase({ unidades: ctx.unidades, perfil: { ...PERFIL, autorizacion_mtc: "" } });
  const hsSin = revisarLicitacion(lic, ctxSinAut).hallazgos;
  check(codigos(hsSin).includes("autorizacion_sin_perfil") && !codigos(hsSin).includes("autorizacion_mtc_distinta"), "sin autorización en el perfil → autorizacion_sin_perfil, nunca «distinta»");
  // Tabla relación de unidades como la propuesta real
  const docR = resolverDocumento({ ...lic, doc: { ...lic.doc, secciones: [...lic.doc.secciones, ...normalizarDoc({ secciones: [{ titulo: "Flota", bloques: [{ tipo: "auto", auto: "relacion_unidades" }] }] }, nid).secciones] } }, ctx, rev);
  const tabla = docR.secciones[1].bloques.find((b) => b.tipo === "tabla");
  check(tabla?.tipo === "tabla" && tabla.columnas.join("|") === "Código|Uso|Tipo|Marca / modelo|Placa|Año", "columnas de la relación de unidades");
  check(tabla?.tipo === "tabla" && tabla.filas[0][4] === "BVI-124" && tabla.filas[3][0] === "U4" && tabla.filas[3][4] === "—", "la placa que no existe sale «—», nunca inventada");
  check(tabla?.tipo === "tabla" && tabla.filas[1][2] === "Bus 25 asientos", "tipo = categoría + asientos de la ficha");
}

// ══ 2. Tabla de `final` según manual × regla ═════════════════════════════════════
sec("2. final = manual si lo hay; si no, la regla; si no, pendiente");
{
  const reglaCumple: Regla = { tipo: "unidades_titulares_min", n: 1 };
  const reglaNoCumple: Regla = { tipo: "unidades_titulares_min", n: 5 };
  const reglaNSJ: Regla = { tipo: "unidad_antiguedad_max", anios: 10, referencia: "presentacion" };
  const ctx = ctxBase({ unidades: { "p:1": unidad("p:1", "AAA-111", { anio: null }) } });
  const casos: { regla: Regla | null; auto: string | null }[] = [{ regla: null, auto: null }, { regla: reglaCumple, auto: "cumple" }, { regla: reglaNoCumple, auto: "no_cumple" }, { regla: reglaNSJ, auto: "no_se_puede_juzgar" }];
  for (const manual of [null, "cumple", "no_cumple", "no_aplica"] as const) for (const c of casos) {
    const q = req("Requisito", c.regla, { manual });
    const lic = licDe({ requisitos: [q], unidades: [{ clave: "p:1", codigo: "U1", rol: "titular" }] });
    const rev = revisarLicitacion(lic, ctx);
    const ev = rev.evaluaciones[0];
    const esperado = manual ?? c.auto ?? "pendiente";
    check(ev.final === esperado, `manual=${manual} auto=${c.auto} → ${esperado} (salió ${ev.final})`);
    check(ev.fuente === (manual ? "manual" : c.regla ? "regla" : "ninguna"), `fuente manual=${manual} auto=${c.auto}`);
    check((ev.auto?.estado ?? null) === c.auto, "auto se publica igual aunque mande la marca manual");
    const contradice = (manual === "cumple" && c.auto === "no_cumple") || (manual === "no_cumple" && c.auto === "cumple");
    check(codigos(rev.hallazgos).includes("requisito_manual_contradice") === contradice, `contradice manual=${manual} auto=${c.auto}`);
    check(codigos(rev.hallazgos).includes("requisito_no_cumple") === (manual === "no_cumple" && !c.regla), `(b) requisito_no_cumple solo sin regla (manual=${manual} auto=${c.auto})`);
    check(codigos(rev.hallazgos).includes("requisito_obligatorio_pendiente") === (esperado === "pendiente" || esperado === "no_se_puede_juzgar"), `(c) obligatorio pendiente manual=${manual} auto=${c.auto}`);
  }
  // (i) sin año: nunca «cumple»
  const lic = licDe({ requisitos: [req("Antigüedad", reglaNSJ)], unidades: [{ clave: "p:1", codigo: "U1", rol: "titular" }] });
  check(evaluarRegla(reglaNSJ, lic, ctx, PRESENTA).estado === "no_se_puede_juzgar", "(i) sin año → no_se_puede_juzgar");
  check(codigos(revisarLicitacion(lic, ctx).hallazgos).includes("unidad_sin_anio"), "(i) y el aviso unidad_sin_anio");
  check(GRAVEDAD_HALLAZGO.unidad_sin_anio === "aviso", "unidad_sin_anio es aviso");
}

// ══ 3. Fuentes caídas: nunca «falta» ═════════════════════════════════════════════
sec("3. Barrido de fuentes caídas: UN fuente_no_leida y ningún «falta» de esa fuente");
{
  const FALTAS: Partial<Record<FuenteContexto, CodigoHallazgo[]>> = {
    unidades: ["unidad_no_existe", "unidad_doc_falta", "unidad_sin_fotos", "unidad_sin_anio", "unidad_sin_capacidad", "unidades_titulares_insuficientes", "reten_insuficiente", "unidad_tercerizada_prohibida"],
    conductores: ["conductor_no_existe", "conductor_sin_licencia", "conductor_doc_no_registrado", "conductores_relevo_insuficientes"],
    legajo: ["legajo_falta", "legajo_sin_archivo"],
    experiencia: ["experiencia_no_existe", "experiencia_cartas_insuficientes", "experiencia_monto_insuficiente", "experiencia_anios_insuficientes"],
    seguros: ["seguro_falta"],
    perfil: ["perfil_incompleto", "autorizacion_sin_perfil"],
    personal: ["representante_incompleto"],
  };
  const reglas: Regla[] = [
    { tipo: "doc_empresa", legajo: "copia_literal", antiguedadMaxDias: 30 }, { tipo: "unidad_doc", doc: "soat", vigenteAl: "presentacion" },
    { tipo: "unidad_fotos" }, { tipo: "unidades_titulares_min", n: 3 }, { tipo: "unidades_reten_min", n: 2 },
    { tipo: "conductor_licencia", categorias: ["A-IIIa"] }, { tipo: "conductor_doc", doc: "examen_medico", antiguedadMaxDias: null },
    { tipo: "conductores_relevo_min", n: 2 }, { tipo: "prohibe_subcontratacion" }, { tipo: "experiencia_anios_min", anios: 2, desde: "constitucion" },
    { tipo: "experiencia_monto_min", monto: 1000, moneda: "PEN" }, { tipo: "experiencia_cartas_min", n: 3 }, { tipo: "seguro", seguro: "responsabilidad_civil", vigenteAl: "presentacion" },
  ];
  const docBase = {
    requisitos: reglas.map((r) => req("x", r)),
    unidades: [{ clave: "t:1", codigo: "U1", rol: "titular" }], conductores: [{ clave: "p:9", rol: "titular" }],
    experiencia: { ids: [50] }, representante: { personalId: 3 },
    expediente: { bloques: [{ titulo: "I", items: [{ fuente: { tipo: "legajo", codigo: "ficha_ruc" } }, { fuente: { tipo: "seguro", seguro: "deshonestidad" } }] }] },
    secciones: [{ titulo: "Datos", bloques: [{ tipo: "auto", auto: "datos_postor" }, { tipo: "parrafo", texto: "R.D. N° 5-2020" }] }],
  };
  const fuentes = Object.keys(FALTAS) as FuenteContexto[];
  let combos = 0;
  for (let mask = 1; mask < 1 << fuentes.length; mask++) {
    const caidas = fuentes.filter((_, k) => mask & (1 << k));
    for (const estado of ["error", "sin_tabla"] as EstadoLectura[]) {
      const lecturas = { ...TODO_OK };
      for (const f of caidas) lecturas[f] = estado;
      // La fuente caída llega VACÍA (como si la lectura no hubiera traído nada): es justo el caso que no puede acusar.
      const ctx = ctxBase({ lecturas, perfil: caidas.includes("perfil") ? null : PERFIL });
      const rev = revisarLicitacion(licDe(docBase), ctx);
      combos++;
      for (const f of caidas) {
        const prohibidos = FALTAS[f] ?? [];
        const malos = rev.hallazgos.filter((h) => prohibidos.includes(h.codigo));
        if (malos.length) { check(false, `fuente ${f} caída (${estado}) acusó ${malos.map((h) => h.codigo).join(", ")}`); break; }
        const fnl = rev.hallazgos.filter((h) => h.codigo === "fuente_no_leida" && h.sujeto.id === `fuente:${f}`);
        check(fnl.length === 1, `fuente ${f} caída → exactamente UN fuente_no_leida (salieron ${fnl.length})`);
      }
    }
  }
  check(combos === 254, `barrido de ${combos} combinaciones de fuentes caídas`);
  // Con todo leído y vacío, SÍ se acusa (corolario: el barrido no es trivial)
  const revOk = revisarLicitacion(licDe(docBase), ctxBase());
  check(["unidad_no_existe", "legajo_falta", "seguro_falta", "experiencia_no_existe", "representante_incompleto"].every((c) => codigos(revOk.hallazgos).includes(c as CodigoHallazgo)), "con todo leído y vacío, los «falta» sí salen");
  check(!codigos(revOk.hallazgos).includes("fuente_no_leida"), "con todo leído no hay fuente_no_leida");
}

// ══ 4. normalizarDoc idempotente ═════════════════════════════════════════════════
sec("4. normalizarDoc: idempotente, tolerante, recorta");
{
  const basura: unknown[] = [
    null, undefined, 42, "texto", [], { esquema: 99 },
    { requisitos: "no es lista", secciones: [null, 3, { titulo: 5, bloques: [{ tipo: "desconocido" }, { tipo: "parrafo" }, { tipo: "tabla", filas: [["a", "b", "c"], ["d"]] }] }] },
    { unidades: [{ clave: "x:1" }, { clave: "p:0" }, { clave: "t:12", rol: "otro" }, { clave: "p:3", id: "dup" }, { clave: "p:4", id: "dup" }] },
    { portada: { color: "rojo" } }, { portada: { color: "#ABCDEF" } },
    { requisitos: [{ id: "r", texto: "a\u0000b", regla: { tipo: "unidad_antiguedad_max", anios: "10" } }, { id: "r", regla: { tipo: "inventada" } }] },
    { secciones: [{ bloques: [{ tipo: "parrafo", texto: "x".repeat(9000) + "😀" }, { tipo: "imagen", anchoPct: 500 }, { tipo: "auto", auto: "cuadro_experiencia", filasExtra: [["a", "", ""], ["b"]] }] }] },
    { secciones: [{ bloques: [{ tipo: "parrafo", texto: "a".repeat(TOPES_DOC.maxTextoBloque - 1) + "😀" }] }] },
    { requisitos: Array.from({ length: TOPES_DOC.maxRequisitos + 5 }, (_, i) => ({ texto: `r${i}` })) },
    { contactos: [{ personalId: 4, nombre: "debe vaciarse" }], representante: { personalId: "7", nombre: "x", dni: "1" } },
    { expediente: { bloques: [{ items: [{ fuente: { tipo: "docs_unidades", doc: "soat", roles: [] } }, { fuente: { tipo: "legajo", codigo: "inventado" } }, { fuente: { tipo: "adjunto", archivo: { url: "u", nombre: "a.docx" } } }] }], foliado: { formato: "sin n", digitos: 99 } } },
    { aceptados: [{ clave: "a" }, { clave: "a" }, { clave: "" }], copiaDe: { licitacionId: 3, cliente_nombre: "X" } },
    { bases: [{ url: "https://x/y.pdf", nombre: "y.pdf", tipo: "tdr" }, { nombre: "sin url" }] },
  ];
  for (const [k, b] of basura.entries()) {
    let d1: DocLicitacion | null = null, lanzo = false;
    try { d1 = normalizarDoc(b, nid); } catch { lanzo = true; }
    check(!lanzo && !!d1, `basura #${k} no lanza`);
    if (!d1) continue;
    const llamadasAntes = contador;
    const d2 = normalizarDoc(d1, nid);
    check(JSON.stringify(d2) === JSON.stringify(d1), `basura #${k}: normalizar dos veces da lo mismo`);
    check(contador === llamadasAntes, `basura #${k}: la segunda pasada no genera ids`);
    const d3 = normalizarDoc(JSON.parse(JSON.stringify(d1)), nid);
    check(JSON.stringify(d3) === JSON.stringify(d1), `basura #${k}: idempotente tras pasar por JSON (jsonb)`);
  }
  const d = normalizarDoc(basura[7], nid);
  check(d.unidades.length === 3 && d.unidades.every((u) => /^[pt]:[1-9]/.test(u.clave)), "claves inválidas descartadas");
  check(new Set(d.unidades.map((u) => u.id)).size === 3, "ids repetidos regenerados");
  check(d.unidades.find((u) => u.clave === "t:12")?.rol === "titular", "rol desconocido → titular");
  check(normalizarDoc(basura[8], nid).portada.color === COLOR_DEFECTO && normalizarDoc(basura[9], nid).portada.color === "#abcdef", "color solo #RRGGBB");
  const r = normalizarDoc(basura[10], nid).requisitos;
  check(r[0].texto === "ab" && r[0].regla?.tipo === "unidad_antiguedad_max" && (r[0].regla as { anios: number }).anios === 10, "NUL fuera, regla con parámetro en texto aceptada");
  check(r[1].regla === null && r[1].id !== r[0].id, "regla inventada → null; id repetido regenerado");
  const s = normalizarDoc(basura[11], nid).secciones[0].bloques;
  check(s[0].tipo === "parrafo" && s[0].texto.length === TOPES_DOC.maxTextoBloque, "texto recortado al tope");
  check(s[1].tipo === "imagen" && s[1].anchoPct === 100, "anchoPct fuera de rango → 100");
  const s2 = normalizarDoc(basura[12], nid).secciones[0].bloques[0];
  check(s2.tipo === "parrafo" && !/[\uD800-\uDBFF]$/.test(s2.texto), "un emoji partido por el tope no deja un sustituto suelto");
  check(normalizarDoc(basura[13], nid).requisitos.length === TOPES_DOC.maxRequisitos, "requisitos recortados al tope");
  const dc = normalizarDoc(basura[14], nid);
  check(dc.contactos[0].nombre === "" && dc.contactos[0].personalId === 4, "contacto con personalId: datos vacíos (se derivan)");
  check(dc.representante.personalId === 7 && dc.representante.nombre === "" && dc.representante.dni === "", "representante con personalId: datos vacíos");
  const de = normalizarDoc(basura[15], nid).expediente;
  check(de.bloques[0].items.length === 2, "fuente inventada descartada");
  check(de.bloques[0].items[0].fuente.tipo === "docs_unidades" && (de.bloques[0].items[0].fuente as { roles: string[] }).roles.length === 2, "roles vacíos → los dos");
  check(de.foliado.formato === "Folio {n}" && de.foliado.digitos === 3 && de.foliado.modo === "ascendente" && de.foliado.posicion === "inferior_derecha" && de.foliado.foliarPortadas, "foliado por defecto (R7)");
  const da = normalizarDoc(basura[16], nid);
  check(da.aceptados.length === 1 && da.copiaDe?.licitacionId === 3, "aceptados sin repetidos ni vacíos; copiaDe");
  check(normalizarDoc(basura[17], nid).bases.length === 1, "una base sin url no es un archivo");
  const v = docVacio(nid);
  check(v.esquema === 1 && v.secciones.length === 0 && v.expediente.foliado.formato === "Folio {n}", "docVacio");
}

// ══ 5. Catálogo ══════════════════════════════════════════════════════════════════
sec("5. CATALOGO_HALLAZGOS: una entrada por código, con título, arreglo y dónde");
{
  const fuente = readFileSync(new URL("../lib/licitaciones/tipos.ts", import.meta.url), "utf8");
  const bloque = fuente.slice(fuente.indexOf("export type CodigoHallazgo"), fuente.indexOf("export const GRAVEDAD_HALLAZGO"));
  const enUnion = [...new Set([...bloque.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))];
  check(enUnion.length === Object.keys(CATALOGO_HALLAZGOS).length, `una entrada por código (${enUnion.length} vs ${Object.keys(CATALOGO_HALLAZGOS).length})`);
  for (const c of enUnion) {
    const e = (CATALOGO_HALLAZGOS as Record<string, { titulo: string; arreglo: string; donde: Record<string, unknown> }>)[c];
    check(!!e, `falta ${c}`);
    if (!e) continue;
    check(e.titulo.trim().length >= 8, `${c}: título`);
    check(e.arreglo.trim().length >= 20, `${c}: arreglo`);
    const d = e.donde;
    check(("paso" in d && PASOS.includes(d.paso as never)) || ("ruta" in d && String(d.ruta).startsWith("/") && String(d.etiqueta).trim() !== ""), `${c}: dónde`);
  }
}

// ══ 6. Legajo, documentos, licencia, experiencia, texto ═══════════════════════════
sec("6a. Legajo");
{
  check(TIPOS_LEGAJO.length === CODIGOS_LEGAJO.length && CODIGOS_LEGAJO.every((c) => TIPOS_LEGAJO.some((t) => t.codigo === c)), "TIPOS_LEGAJO cubre CODIGOS_LEGAJO");
  check(["copia_literal", "vigencia_poder", "ficha_ruc"].every((c) => TIPOS_LEGAJO.find((t) => t.codigo === c)?.antiguedadSugeridaDias === 30), "copia literal, vigencia de poder y ficha RUC: 30 días sugeridos");
  check(TIPOS_LEGAJO.find((t) => t.codigo === "dni_representante")?.vence === "fecha", "el DNI vence por fecha");
  check(TIPOS_DOC_CONDUCTOR.length === CODIGOS_DOC_CONDUCTOR.length, "TIPOS_DOC_CONDUCTOR cubre los códigos");
  check(TIPOS_DOC_CONDUCTOR.find((t) => t.codigo === "examen_medico")?.columna === "examen_medico_venc" && TIPOS_DOC_CONDUCTOR.find((t) => t.codigo === "antecedentes_policiales")?.columna === "antecedentes_venc" && TIPOS_DOC_CONDUCTOR.find((t) => t.codigo === "licencia_conducir")?.columna === "vencimiento_licencia", "columnas de vencimiento del conductor");
  const url = PUB("documentos", "legajo/cl.pdf");
  const emitida = "2026-10-03";             // 31 días antes de la presentación
  check(estadoLegajo("copia_literal", [filaLeg(1, "copia_literal", emitida, null, url)], PRESENTA, 30).estado === "antiguo", "copia literal de hace 31 días con máximo 30 → antiguo");
  check(estadoLegajo("copia_literal", [filaLeg(1, "copia_literal", "2026-10-04", null, url)], PRESENTA, 30).estado === "vigente", "de hace 30 días → vigente");
  check(estadoLegajo("copia_literal", [filaLeg(1, "copia_literal", emitida, null, null)], PRESENTA, 30).estado === "sin_archivo", "sin archivo");
  check(estadoLegajo("dni_representante", [filaLeg(1, "dni_representante", null, "2026-11-01", url)], PRESENTA, null).estado === "vencido", "vencido a la presentación");
  check(estadoLegajo("copia_literal", [filaLeg(1, "copia_literal", null, null, url)], PRESENTA, 30).estado === "sin_fecha_emision", "sin fecha de emisión cuando se exige antigüedad");
  check(estadoLegajo("copia_literal", [], PRESENTA, 30).estado === "falta", "falta");
  check(estadoLegajo("ficha_ruc", [filaLeg(1, "ficha_ruc", "2020-01-01", "2020-02-01", url)], PRESENTA, null).estado === "vigente", "un documento que no vence ignora su fecha de vencimiento");
  const varias = [filaLeg(1, "copia_literal", "2026-09-01", null, url), filaLeg(2, "copia_literal", "2026-10-20", null, null), filaLeg(3, "copia_literal", "2026-10-10", null, url)];
  check(documentoVigente("copia_literal", varias, null)?.id === 3, "el más reciente CON archivo");
  check(documentoVigente("copia_literal", varias, 1)?.id === 1, "el fijado manda");
  check(documentoVigente("copia_literal", varias, 99)?.id === 3, "fijado inexistente → el más reciente con archivo");
  const lic = licDe({ requisitos: [req("Copia literal ≤ 30 días", { tipo: "doc_empresa", legajo: "copia_literal", antiguedadMaxDias: 30 }, { categoria: "legal" })], expediente: { bloques: [{ titulo: "I", items: [{ fuente: { tipo: "legajo", codigo: "copia_literal", documentoId: 99 } }] }] } });
  const hs = revisarLicitacion(lic, ctxBase({ legajo: [filaLeg(1, "copia_literal", emitida, null, url)] })).hallazgos;
  check(codigos(hs).includes("legajo_antiguo") && codigos(hs).includes("legajo_documento_fijado_no_existe"), "la revisión dice legajo_antiguo y el fijado que no existe");
  check(GRAVEDAD_HALLAZGO.legajo_antiguo === "alarma", "legajo_antiguo es alarma");
  // nunca lee la columna `estado` guardada
  const conEstado = { ...filaLeg(1, "copia_literal", emitida, null, url), estado: "vigente" } as FilaDocEmpresa;
  check(estadoLegajo("copia_literal", [conEstado], PRESENTA, 30).estado === "antiguo", "la columna `estado` guardada no se lee");
}

sec("6b. Documentos de la unidad");
{
  const u = unidad("p:1", "AAA-111", {
    flota: "p",
    docs: [
      docU(1, "SOAT", "2026-11-01", PUB("documentos", "x/soat.pdf"), false, "documentos_vehiculo"),
      docU(2, "Revisión Técnica (CITV)", "2026-11-05", PUB("documentos", "x/citv.pdf"), false, "documentos_vehiculo"),
      docU(3, "TUC", "2027-12-01", "https://drive.google.com/file/d/abc/view", false, "documentos_vehiculo"),
      docU(4, "tarjeta de identificacion vehicular", "2001-01-01", PUB("documentos", "x/tp.pdf"), false, "documentos_vehiculo"),
    ],
  });
  check(docsDeUnidad(u, "soat", PRESENTA).estado === "vencido", "SOAT vencido a la presentación");
  check(docsDeUnidad(u, "citv", PRESENTA).estado === "por_vencer" && docsDeUnidad(u, "citv", INICIO).estado === "vencido", "CITV vigente al presentar y vencida al inicio");
  check(docsDeUnidad(u, "tuc", PRESENTA).origen === "externo", "enlace de Drive → externo");
  check(docsDeUnidad(u, "tarjeta_propiedad", PRESENTA).estado === "no_vence", "la Tarjeta de Propiedad no vence (alias TIVE)");
  check(docsDeUnidad(u, "habilitacion", PRESENTA).estado === "falta", "falta");
  const dosSoat = unidad("p:2", "BBB-222", { docs: [docU(1, "SOAT", "2026-01-01", null), docU(2, "SOAT", "2027-01-01", PUB("documentos", "s2.pdf")), docU(3, "CAT", "2026-12-01", null)] });
  check(docsDeUnidad(dosSoat, "soat", PRESENTA).fila?.id === 2, "entre renovaciones, la de vencimiento más lejano");
  const tercero = unidad("t:3", "CCC-333", { docs: [docU(1, "SOAT", "2027-01-01", PUB("documentos", "e.pdf"), true)] });
  const propiaConEmpresa = unidad("p:3", "DDD-444", { docs: [docU(1, "SOAT", "2027-01-01", PUB("documentos", "e.pdf"), true)] });
  check(docsDeUnidad(tercero, "soat", PRESENTA).deEmpresa === true && docsDeUnidad(tercero, "soat", PRESENTA).estado === "vigente", "tercero: los de la empresa cuentan");
  check(docsDeUnidad(propiaConEmpresa, "soat", PRESENTA).estado === "falta", "propia: los de empresa no cuentan");
  const lic = licDe({
    requisitos: [req("SOAT", { tipo: "unidad_doc", doc: "soat", vigenteAl: "presentacion" }), req("CITV", { tipo: "unidad_doc", doc: "citv", vigenteAl: "presentacion" }), req("TUC", { tipo: "unidad_doc", doc: "tuc", vigenteAl: "presentacion" })],
    unidades: [{ clave: "p:1", codigo: "U1", rol: "titular" }],
  });
  const hs = revisarLicitacion(lic, ctxBase({ unidades: { "p:1": u } })).hallazgos;
  check(codigos(hs).includes("unidad_doc_vencido_al_presentar"), "unidad_doc_vencido_al_presentar");
  check(codigos(hs).includes("unidad_doc_vence_antes_inicio"), "unidad_doc_vence_antes_inicio");
  const ext = hs.find((h) => h.codigo === "unidad_doc_archivo_externo");
  check(!!ext && "ruta" in ext.donde && ext.donde.ruta === "/documentos-vehiculares", "Drive → unidad_doc_archivo_externo, se arregla en Docs. Vehiculares");
  check(revisarLicitacion(lic, ctxBase({ unidades: { "p:1": u } })).evaluaciones[1].final === "cumple", "vence antes del inicio con vigenteAl=presentación: cumple (y avisa)");
  // (d) sin regla ni expediente, los documentos de la unidad no se juzgan
  const sinNada = licDe({ unidades: [{ clave: "p:1", codigo: "U1", rol: "titular" }] });
  check(!revisarLicitacion(sinNada, ctxBase({ unidades: { "p:1": u } })).hallazgos.some((h) => h.codigo.startsWith("unidad_doc")), "(d) sin regla ni expediente no se juzgan documentos");
  const conExp = licDe({ unidades: [{ clave: "p:1", codigo: "U1", rol: "titular" }], expediente: { bloques: [{ titulo: "III", items: [{ fuente: { tipo: "docs_unidades", doc: "soat" } }] }] } });
  check(codigos(revisarLicitacion(conExp, ctxBase({ unidades: { "p:1": u } })).hallazgos).includes("unidad_doc_vencido_al_presentar"), "(d) el expediente los incluye → se juzgan");
  const r = resumenUnidad(u, { presentacion: PRESENTA, inicio: INICIO });
  check(r.docs.citv.inicio?.estado === "vencido" && r.antiguedad === 6, "resumenUnidad: vigencia al inicio y antigüedad");
}

sec("6c. Licencia y documentos del conductor");
{
  const ctx = ctxBase({ conductores: { "p:1": conductor("p:1", "Juan Pérez", "A-IIIb"), "p:2": conductor("p:2", "Ana Ruiz", "A-IIIc"), "t:3": conductor("t:3", "Luis Tercero", "AIIIA") } });
  const regla: Regla = { tipo: "conductor_licencia", categorias: ["A-IIIa"] };
  const lic = licDe({ requisitos: [req("Licencia A-IIIa", regla)], conductores: [{ clave: "p:1", rol: "titular" }, { clave: "p:2", rol: "titular" }, { clave: "t:3", rol: "relevo" }] });
  const hs = revisarLicitacion(lic, ctx).hallazgos;
  const ins = hs.filter((h) => h.codigo === "conductor_categoria_insuficiente");
  check(ins.length === 1 && ins[0].texto.includes("Juan Pérez"), "A-IIIb (carga) para un bus que exige A-IIIa → categoría insuficiente; A-IIIc y «AIIIA» alcanzan");
  check(evaluarRegla(regla, lic, ctx, PRESENTA).estado === "no_cumple", "la regla no cumple");
  // tri-estado del tercero: la columna no existe (undefined) ≠ vacía (null)
  const t = conductor("t:3", "Luis Tercero", "A-IIIa");
  check(t.examen_medico_venc === undefined && resumenConductor(t, { presentacion: PRESENTA, inicio: null }).docs.examen_medico.columna === "no_existe", "tercero: la columna no existe");
  const p = conductor("p:4", "Sin Examen", "A-IIIa", { examen_medico_venc: null });
  check(resumenConductor(p, { presentacion: PRESENTA, inicio: null }).docs.examen_medico.columna === "vacia", "propio: la columna existe y está vacía");
  const reglaDoc: Regla = { tipo: "conductor_doc", doc: "examen_medico", antiguedadMaxDias: null };
  const licT = licDe({ requisitos: [req("Examen médico", reglaDoc)], conductores: [{ clave: "t:3", rol: "titular" }] });
  const ctxT = ctxBase({ conductores: { "t:3": t }, migraciones: { anioTercero: true, conductorTercero: false, fechaConstitucion: true } });
  const evT = evaluarRegla(reglaDoc, licT, ctxT, PRESENTA);
  check(evT.estado === "no_se_puede_juzgar" && !codigos(revisarLicitacion(licT, ctxT).hallazgos).includes("conductor_doc_no_registrado"), "tercero sin dónde registrar el documento: no se juzga, no se acusa");
  const licP = licDe({ requisitos: [req("Examen médico", reglaDoc)], conductores: [{ clave: "p:4", rol: "titular" }] });
  check(codigos(revisarLicitacion(licP, ctxBase({ conductores: { "p:4": p } })).hallazgos).includes("conductor_doc_no_registrado"), "propio con la columna vacía: no registrado");
  const vencido = conductor("p:5", "Vencido", "A-IIIa", { examen_medico_venc: "2026-10-01", archivos: [{ ...filaLeg(9, "examen_medico", "2026-01-01", "2026-12-01", PUB("documentos", "em.pdf")), alcance: "conductor", conductor_id: 5 }] });
  const hsV = revisarLicitacion(licDe({ requisitos: [req("Examen", reglaDoc)], conductores: [{ clave: "p:5", rol: "titular" }] }), ctxBase({ conductores: { "p:5": vencido } })).hallazgos;
  check(codigos(hsV).includes("conductor_doc_vencido") && codigos(hsV).includes("conductor_doc_fechas_distintas"), "vale la fecha de la ficha; la del archivo distinta se avisa");
}

sec("6d. Experiencia por moneda");
{
  const ctx = ctxBase({ experiencia: { 1: exp(1, "Cliente Uno", "2017-02-01", 1000), 2: exp(2, "Cliente Dos", "2020-01-01", 500, "USD"), 3: exp(3, "Cliente Tres", "2023-01-01", 2000) } });
  const lic = licDe({ experiencia: { ids: [1, 2, 3] }, secciones: [{ titulo: "Exp", bloques: [{ tipo: "auto", auto: "cuadro_experiencia" }, { tipo: "parrafo", texto: "Total: {total_experiencia}" }] }] });
  const v = valoresVariables(lic, ctx);
  check(v.total_experiencia === "S/ 3,000.00 · US$ 500.00", `(e) PEN y USD sin sumarse (${v.total_experiencia})`);
  check(v.anios_experiencia === "9", `años desde el primer contrato (${v.anios_experiencia})`);
  const rev = revisarLicitacion(lic, ctx);
  check(codigos(rev.hallazgos).includes("experiencia_moneda_mixta"), "moneda mixta (info)");
  const monto = evaluarRegla({ tipo: "experiencia_monto_min", monto: 2500, moneda: "PEN" }, lic, ctx, PRESENTA);
  check(monto.estado === "cumple", "monto en soles alcanzado con los contratos en soles");
  const monto2 = evaluarRegla({ tipo: "experiencia_monto_min", monto: 5000, moneda: "PEN" }, lic, ctx, PRESENTA);
  check(monto2.estado === "no_se_puede_juzgar", "no alcanza en soles pero hay dólares: no se afirma que falte (no se convierte)");
  const soloPen = licDe({ experiencia: { ids: [1, 3] } });
  check(evaluarRegla({ tipo: "experiencia_monto_min", monto: 5000, moneda: "PEN" }, soloPen, ctx, PRESENTA).estado === "no_cumple", "solo soles y no alcanza → no cumple");
  const exr = resolverExpediente(licDe({ experiencia: { ids: [1, 2, 3] }, expediente: { bloques: [{ titulo: "VIII", items: [{ fuente: { tipo: "cuadro_experiencia" } }] }] } }), ctx, rev);
  const cuadro = exr.bloques[0].partes[0];
  check(cuadro.tipo === "cuadro_experiencia" && cuadro.cuadro.totales.length === 2 && cuadro.cuadro.totales[0].moneda === "PEN" && cuadro.cuadro.totales[0].importe === 3000, "cuadro: un total por moneda");
  check(cuadro.tipo === "cuadro_experiencia" && cuadro.cuadro.tabla.pie === null && cuadro.cuadro.tabla.columnas.at(-1) === "Importe", "cuadro: importe en la última columna y pie null (el PDF arma «TOTAL:»)");
  check(cuadro.tipo === "cuadro_experiencia" && !!cuadro.cuadro.lugarFecha && cuadro.cuadro.lugarFecha.includes("2026"), "cuadro: lugar y fecha encima de la firma");
  const doc = resolverDocumento(lic, ctx, rev);
  const t = doc.secciones[0].bloques.find((b) => b.tipo === "tabla");
  check(t?.tipo === "tabla" && t.pie?.at(-1) === "S/ 3,000.00 · US$ 500.00", "propuesta: el pie del cuadro tiene un total por moneda");
}

sec("6e. Texto de otra licitación");
{
  const otras = [{ id: 9, nombre: "Licitación AC Farma", cliente_nombre: "AC Farma S.A.", codigo: "LP-AC-2026", cliente_erp: null }];
  const ctx = ctxBase({ otras, experiencia: { 5: exp(5, "Snacks America Latina S.R.L.", "2020-09-01", 10) } });
  const conTexto = (t: string, ids: number[] = []) => revisarLicitacion(licDe({ experiencia: { ids }, secciones: [{ titulo: "S", bloques: [{ tipo: "parrafo", texto: t }] }] }), ctx).hallazgos;
  check(codigos(conTexto("Ofrecemos a AC FARMA S.A. el mejor servicio.")).includes("texto_de_otra_licitacion"), "menciona al cliente de otra licitación → alarma");
  check(codigos(conTexto("Referencia LP-AC-2026.")).includes("texto_de_otra_licitacion"), "menciona el código de otra licitación");
  check(!codigos(conTexto("Ofrecemos a MASS – CD Villa El Salvador el servicio.")).includes("texto_de_otra_licitacion"), "el cliente propio no alarma");
  check(!codigos(conTexto("Experiencia con AC Farmacéutica.")).includes("texto_de_otra_licitacion"), "palabra COMPLETA: «Farmacéutica» no es «Farma»");
  const ctxExp = ctxBase({ otras: [{ id: 9, nombre: "Otra", cliente_nombre: "Snacks America Latina S.R.L.", codigo: null, cliente_erp: null }], experiencia: ctx.experiencia });
  check(!revisarLicitacion(licDe({ experiencia: { ids: [5] }, secciones: [{ titulo: "S", bloques: [{ tipo: "parrafo", texto: "Atendemos a Snacks America Latina S.R.L." }] }] }), ctxExp).hallazgos.some((h) => h.codigo === "texto_de_otra_licitacion"), "un cliente de la experiencia elegida no alarma");
  const desdeCopia = licDe({ copiaDe: { licitacionId: 9, cliente_nombre: "Hermes Transportes", codigo: null }, secciones: [{ titulo: "S", bloques: [{ tipo: "parrafo", texto: "Propuesta para Hermes Transportes" }] }] });
  check(codigos(revisarLicitacion(desdeCopia, ctxBase()).hallazgos).includes("texto_de_otra_licitacion"), "el cliente de la licitación de la que se copió también");
  const enAuto = licDe({ secciones: [{ titulo: "S", bloques: [{ tipo: "auto", auto: "cuadro_experiencia", filasExtra: [["AC Farma S.A."]] }] }] });
  check(!codigos(revisarLicitacion(enAuto, ctx).hallazgos).includes("texto_de_otra_licitacion"), "el texto de un bloque automático no cuenta");
}

// ══ 7. Variables, negrita, documento, expediente, plantilla ══════════════════════
sec("7a. Variables y negrita");
{
  check(new Set(VARIABLES.map((v) => v.nombre)).size === VARIABLES.length && VARIABLES.length === 26, "26 variables sin repetir");
  const r = resolverVariables("RUC {ruc}, {cliente} y {inventada}", { ruc: null, cliente: "Cliente X" });
  check(r.texto === "RUC {ruc}, Cliente X y {inventada}" && r.faltan.join() === "ruc" && r.desconocidas.join() === "inventada", "sin valor queda visible y va a faltan");
  check(JSON.stringify(trozosDe("a **b** c **d")) === JSON.stringify([{ texto: "a ", negrita: false }, { texto: "b", negrita: true }, { texto: " c **d", negrita: false }]), "solo **cerrado** es negrita");
  const lic = licDe({ secciones: [{ titulo: "S", bloques: [{ tipo: "parrafo", texto: "Para {cliente}. Contacto {telefono}. {nada} [COMPLETAR: algo]" }] }] });
  const ctx = ctxBase({ perfil: { ...PERFIL, telefono: "" } });
  const esc = escanearTexto(lic, ctx);
  check(esc.completar.length === 1 && esc.variables.map((x) => x.nombre).sort().join() === "nada,telefono", "escaneo: [COMPLETAR], variable sin valor y desconocida");
  const hs = revisarLicitacion(lic, ctx).hallazgos;
  check(cuantos(hs, "variable_sin_resolver") === 2 && cuantos(hs, "marca_completar") === 1, "revisión: variable_sin_resolver ×2 y marca_completar");
  const doc = resolverDocumento(lic, ctx, revisarLicitacion(lic, ctx));
  const p = doc.secciones[0].bloques[0];
  check(p.tipo === "parrafo" && p.texto.startsWith("Para MASS – CD Villa El Salvador. Contacto {telefono}."), "el documento resuelve lo que tiene valor y deja visible lo demás");
  const inactivo = licDe({ secciones: [{ titulo: "S", activa: false, bloques: [{ tipo: "parrafo", texto: "{nada} [COMPLETAR]" }] }, { titulo: "Ok", bloques: [{ tipo: "parrafo", texto: "x" }] }] });
  check(!revisarLicitacion(inactivo, ctx).hallazgos.some((h) => h.codigo === "marca_completar"), "lo que no se imprime (sección inactiva) no se escanea");
}

sec("7b. resolverDocumento");
{
  const ctx = ctxBase({ unidades: { "p:1": unidad("p:1", "AAA-111", { anio: 2016 }) } });
  const q1 = req("Unidades de máximo 10 años", { tipo: "unidad_antiguedad_max", anios: 10, referencia: "presentacion" }, { numeral: "10", categoria: "unidad" });
  const q2 = req("Declaraciones juradas", null, { numeral: "5.3", manual: "cumple", sustento: "Anexos firmados", categoria: "declaracion" });
  const q3 = req("Fuera de la matriz", null, { enMatriz: false });
  const lic = licDe({
    requisitos: [q1, q2, q3], unidades: [{ clave: "p:1", codigo: "U1", rol: "titular" }],
    consultas: [{ numero: "pregunta 3", pregunta: "Control de abordaje", respuesta: "Obligatorio", incorporacion: "Registro QR" }],
    carta: { activa: true, cuerpo: "Primer párrafo.\n\nSegundo párrafo de {cliente}." },
    secciones: [
      { titulo: "Resumen", bloques: [{ tipo: "subtitulo", texto: "Cifras", nivel: 2 }, { tipo: "subtitulo", texto: "Detalle", nivel: 3 }, { tipo: "subtitulo", texto: "Otra", nivel: 2 }] },
      { titulo: "Inactiva", activa: false, bloques: [] },
      { titulo: "Cumplimiento", bloques: [{ tipo: "auto", auto: "matriz_cumplimiento", filasExtra: [["Extra a mano", "Sí"]] }, { tipo: "auto", auto: "absolucion_consultas" }, { tipo: "auto", auto: "exigido_ofertado" }, { tipo: "imagen" }] },
      { titulo: "Adjuntos", numerada: false, bloques: [{ tipo: "auto", auto: "relacion_adjuntos" }] },
    ],
    expediente: { bloques: [{ id: "bx", titulo: "Sección I", subtitulo: "Requisitos del postor", referencia: "Numeral 5.1", items: [{ fuente: { tipo: "legajo", codigo: "ficha_ruc" } }] }] },
  });
  const rev = revisarLicitacion(lic, ctx);
  const d = resolverDocumento(lic, ctx, rev, { folios: { bx: { desde: 1, hasta: 12 } } });
  check(d.secciones.length === 3 && d.secciones.map((s) => s.numero).join() === "1,2,", "solo activas, numeradas en orden (una sin numerar)");
  const subs = d.secciones[0].bloques.filter((b) => b.tipo === "subtitulo").map((b) => (b as { numero: string | null }).numero);
  check(subs.join() === "1.1,1.1.1,1.2", `subtítulos 1.1 · 1.1.1 · 1.2 (${subs.join()})`);
  const [matriz, absol, exig] = d.secciones[1].bloques.filter((b) => b.tipo === "tabla") as Extract<(typeof d.secciones)[0]["bloques"][0], { tipo: "tabla" }>[];
  check(matriz.columnas.join("|") === "Requisito|Cumple|Sustento adjunto", "matriz: columnas");
  check(matriz.filas.length === 3 && matriz.filas[0][0] === "Unidades de máximo 10 años (10)" && matriz.filas[0][1] === "Sí" && matriz.filas[1][2] === "Anexos firmados" && matriz.filas[2][0] === "Extra a mano" && matriz.filas[2][2] === "", "matriz: requisitos en la matriz, estado, sustento y la fila extra al final");
  check(absol.columnas[1] === "Respuesta de MASS – CD Villa El Salvador" && absol.filas[0][0] === "Control de abordaje (pregunta 3)", "absolución de consultas");
  check(exig.filas.length === 1 && exig.filas[0][2] === "Unidades 2016", `exigido vs. ofertado (${exig.filas[0]?.[2]})`);
  check(!d.secciones[1].bloques.some((b) => b.tipo === "imagen"), "una imagen sin archivo no se imprime (la revisión la nombra)");
  const adj = d.secciones[2].bloques[0];
  check(adj.tipo === "tabla" && adj.columnas.at(-1) === "Folios" && adj.filas[0][3] === "001–012" && adj.filas[0][0] === "Sección I — Requisitos del postor", "relación de adjuntos con folios de ancho fijo");
  const d2 = resolverDocumento(lic, ctx, rev);
  check((d2.secciones[2].bloques[0] as { filas: string[][] }).filas[0][3] === "—", "sin folios: «—», nunca un cero");
  check(d.carta?.cuerpo.length === 2 && d.carta.cuerpo[1] === "Segundo párrafo de MASS – CD Villa El Salvador.", "carta: párrafos y variables");
  check(d.carta?.destinatario[0] === "Señores" && d.carta.destinatario.some((s) => s.includes("Atención: Ejecutivo de Compras")), "carta: destinatario por defecto con la atención");
  check(d.pie.derecha.includes("{pagina} de {total}") && d.pie.izquierda.includes("RUC 20999999999"), "pie");
  check(d.control?.some(([k, v]) => k === "Postor" && v.includes("EMPRESA DEMO")), "control: postor del perfil");
  check(d.firmante === null, "sin representante no hay firmante");
  const sinPerfil = resolverDocumento(lic, ctxBase({ perfil: null }), rev);
  check(!JSON.stringify(sinPerfil).includes("CONFIGURA"), "sin perfil no se imprime el aviso «configura» como si fuera un nombre");
}

sec("7c. expedientePorDefecto y resolverExpediente");
{
  const def = expedientePorDefecto(docVacio(nid), null, nid);
  check(def.bloques.map((b) => b.subtitulo || b.titulo).join(" | ") === "Requisitos del postor | Declaraciones juradas | Unidades | Conductores | Seguros y garantías | Emergencias | SST y políticas | Experiencia | Documentos complementarios", "sin requisitos: la estructura completa de la propuesta real");
  check(def.bloques.slice(0, 8).map((b) => b.titulo).join() === "Sección I,Sección II,Sección III,Sección IV,Sección V,Sección VI,Sección VII,Sección VIII", "numeración romana");
  const conReq = normalizarDoc({ requisitos: [req("Ficha RUC", { tipo: "doc_empresa", legajo: "ficha_ruc", antiguedadMaxDias: 30 }, { numeral: "5.1", categoria: "legal" }), req("Licencia", null, { categoria: "conductor", numeral: "10" })] }, nid);
  const ex2 = expedientePorDefecto(conReq, null, nid);
  check(ex2.bloques.length === 2 && ex2.bloques[0].subtitulo === "Requisitos del postor" && ex2.bloques[0].referencia === "Numeral 5.1" && ex2.bloques[1].subtitulo === "Conductores", "con requisitos: solo los bloques de sus categorías, con su referencia");
  const u1 = unidad("p:1", "AAA-111", { docs: [docU(1, "SOAT", "2027-01-01", PUB("documentos", "a.pdf"), false, "documentos_vehiculo")] });
  const u2 = unidad("p:2", "BBB-222", { docs: [docU(1, "SOAT", "2027-01-01", "https://drive.google.com/x", false, "documentos_vehiculo")] });
  const u3 = unidad("p:3", "CCC-333", { docs: [] });
  const ctx = ctxBase({ unidades: { "p:1": u1, "p:2": u2, "p:3": u3 }, legajo: [filaLeg(1, "copia_literal", "2026-10-20", null, PUB("documentos", "cl.pdf"))] });
  const lic = licDe({
    requisitos: [req("Copia literal", { tipo: "doc_empresa", legajo: "copia_literal", antiguedadMaxDias: 30 })],
    unidades: [{ clave: "p:3", codigo: "R1", rol: "reten" }, { clave: "p:2", codigo: "U10", rol: "titular" }, { clave: "p:1", codigo: "U2", rol: "titular" }, { clave: "p:9", codigo: "U3", rol: "titular" }],
    expediente: { bloques: [
      { titulo: "Sección II", subtitulo: "Requisitos legales", items: [{ fuente: { tipo: "legajo", codigo: "copia_literal" } }, { fuente: { tipo: "legajo", codigo: "vigencia_poder" } }, { incluido: false, fuente: { tipo: "legajo", codigo: "ficha_ruc" } }] },
      { titulo: "Sección III", subtitulo: "Unidades", items: [{ fuente: { tipo: "docs_unidades", doc: "soat" } }, { fuente: { tipo: "adjunto", archivo: { url: PUB("licitaciones", "adjuntos/7/x.docx"), nombre: "dj.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } } }] },
      { titulo: "Inactivo", activo: false, items: [{ fuente: { tipo: "propuesta" } }] },
    ] },
  });
  const rev = revisarLicitacion(lic, ctx);
  const ex = resolverExpediente(lic, ctx, rev);
  check(ex.bloques.length === 2, "solo bloques activos");
  check(ex.bloques[0].separador.contenido.join(" • ") === "Copia literal de partida registral (antigüedad no mayor a 30 días) • Vigencia de poder del representante", "«Contenido:» de los ítems incluidos, con la antigüedad de la regla");
  check(ex.bloques[0].partes[0].tipo === "archivo" && ex.bloques[0].partes[1].tipo === "faltante" && (ex.bloques[0].partes[1] as { codigo: string }).codigo === "legajo_falta", "legajo: archivo y faltante con su código");
  const p3 = ex.bloques[1].partes;
  const titulos = p3.map((p) => ("titulo" in p ? p.titulo : p.tipo));
  check(titulos.slice(0, 4).join(" | ") === "SOAT · R1 · CCC-333 | SOAT · U2 · AAA-111 | SOAT · U3 | SOAT · U10 · BBB-222", `una parte por unidad en orden de código (${titulos.slice(0, 4).join(" | ")})`);
  check(p3.map((p) => (p.tipo === "faltante" ? p.codigo : p.tipo)).join() === "unidad_doc_falta,archivo,unidad_no_existe,unidad_doc_archivo_externo,adjunto_no_unible", "faltantes con su código (falta, no existe, Drive, Word)");
  check(codigos(rev.hallazgos).includes("adjunto_no_unible") && codigos(rev.hallazgos).includes("unidad_doc_archivo_externo"), "la revisión nombra lo que se omitirá");
  // RevisionArchivo y emisión anterior
  const urlCl = PUB("documentos", "cl.pdf");
  const rev2 = revisarLicitacion(lic, ctx, { [urlCl]: { url: urlCl, ok: false, codigo: "pdf_protegido", detalle: "cifrado" } });
  check(codigos(rev2.hallazgos).includes("pdf_protegido"), "un PDF cifrado comprobado → pdf_protegido");
  const ultima = { id: 1, licitacion_id: 7, version: 2, carpeta: "c", emitido_por: "u", emitido_en: "", doc_version: 1, firma: "f", archivos: [], hallazgos: [], omitidos: [], nota: null,
    foto: { fuentes: [{ itemId: "x", url: urlCl, sha256: "a".repeat(64), bytes: 1, paginas: 1 }] } } as never;
  const rev3 = revisarLicitacion(lic, ctx, { [urlCl]: { url: urlCl, ok: true, formato: "pdf", paginas: 2, bytes: 10, sha256: "b".repeat(64) } }, ultima);
  check(codigos(rev3.hallazgos).includes("archivo_cambio_desde_emision"), "archivo cambiado desde la última emisión (info)");
}

sec("7d. Plantilla base: sin cifras ni nombres");
{
  const d = docDesdePlantilla(nid);
  check(d.secciones.length === 20, `veinte secciones (${d.secciones.length})`);
  check(JSON.stringify(normalizarDoc(d, nid)) === JSON.stringify(d), "la plantilla ya está normalizada");
  const textos: string[] = [];
  const recoger = (x: unknown) => {
    if (typeof x === "string") textos.push(x);
    else if (Array.isArray(x)) x.forEach(recoger);
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "id" || k === "color") continue; recoger(v); }
  };
  recoger({ ...d, expediente: { bloques: d.expediente.bloques.map((b) => ({ titulo: b.titulo, subtitulo: b.subtitulo, referencia: b.referencia })) } });
  const conCifras = textos.filter((t) => /\d{2,}/.test(t));
  check(conCifras.length === 0, `ningún número de 2+ cifras (${conCifras.slice(0, 3).join(" | ")})`);
  const PROHIBIDO = /\bAFA\b|MASS|LATAM|Campana|BCP|Lurigancho|Villa El Salvador|R\.\s?D\.|[A-Z]{3}-?\d{3}\b|\+51|@|\.com|transportesafa/i;
  const malos = textos.filter((t) => PROHIBIDO.test(t));
  check(malos.length === 0, `ningún nombre, placa, teléfono, correo ni R.D. (${malos.slice(0, 3).join(" | ")})`);
  const autos = d.secciones.flatMap((s) => s.bloques).filter((b) => b.tipo === "auto").map((b) => (b as { auto: string }).auto);
  check(["datos_postor", "cuadro_experiencia", "matriz_cumplimiento", "absolucion_consultas", "relacion_unidades", "exigido_ofertado", "conductores", "contactos", "relacion_adjuntos"].every((a) => autos.includes(a)), "las tablas que arma el ERP son bloques automáticos");
  check(d.expediente.bloques.length === 9, "expediente completo");
  // La plantilla aplicada a una licitación con datos: lo que falta se nombra, no se inventa.
  const lic = licDe(d);
  const rev = revisarLicitacion(lic, ctxBase());
  check(codigos(rev.hallazgos).includes("marca_completar") && codigos(rev.hallazgos).includes("variable_sin_resolver"), "con la plantilla, las marcas y variables vacías se nombran");
}

sec("7e. duplicarDoc");
{
  const origen = licDe({
    requisitos: [req("R", null, { manual: "cumple" })], unidades: [{ clave: "p:1", codigo: "U1" }], aceptados: [{ clave: "x", nota: "n", por: null, en: "" }],
    analisis: { aplicadoId: 3, aceptados: ["a"] }, consultas: [{ pregunta: "q", respuesta: "r" }], bases: [{ url: "https://x/a.pdf", nombre: "a.pdf" }],
    carta: { destinatario: "Señores AC Farma", atencion: "Sr. X" },
    secciones: [{ titulo: "S", bloques: [{ tipo: "parrafo", texto: "t" }] }],
    expediente: { bloques: [{ id: "b1", titulo: "I", items: [{ fuente: { tipo: "adjunto", archivo: { url: "https://x/dj.pdf", nombre: "dj.pdf" } } }] }] },
  }, { cliente_nombre: "AC Farma S.A.", codigo: "LP-1" });
  origen.doc.requisitos[0].bloqueExpedienteId = origen.doc.expediente.bloques[0].id;
  const c1 = duplicarDoc(origen, { nuevoId: nid, conRecursos: true, conRequisitos: true });
  check(c1.copiaDe?.cliente_nombre === "AC Farma S.A." && c1.copiaDe.codigo === "LP-1" && c1.copiaDe.licitacionId === 7, "copiaDe con cliente y código del origen");
  check(c1.aceptados.length === 0 && c1.analisis.aplicadoId === null && c1.analisis.aceptados.length === 0, "sin aceptados ni análisis");
  check(c1.bases.length === 0 && c1.consultas.length === 0, "sin bases ni consultas del otro concurso");
  check(c1.requisitos[0].manual === null && c1.requisitos[0].origen === "copia" && c1.requisitos[0].bloqueExpedienteId === c1.expediente.bloques[0].id, "requisitos sin marca manual, origen copia y vínculo al bloque nuevo");
  check(c1.secciones[0].id !== origen.doc.secciones[0].id && c1.expediente.bloques[0].id !== origen.doc.expediente.bloques[0].id && c1.unidades[0].id !== origen.doc.unidades[0].id, "ids nuevos");
  check(c1.expediente.bloques[0].items[0].fuente.tipo === "adjunto" && (c1.expediente.bloques[0].items[0].fuente as { archivo: unknown }).archivo === null, "los adjuntos firmados quedan pendientes de subir");
  check(c1.carta.destinatario === "" && c1.carta.atencion === "", "la carta no se lleva al otro cliente");
  const c2 = duplicarDoc(origen, { nuevoId: nid, conRecursos: false, conRequisitos: false });
  check(c2.requisitos.length === 0 && c2.unidades.length === 0, "sin recursos ni requisitos si no se piden");
}

// ══ 8. Corolario: el barrido produce las tres gravedades ══════════════════════════
sec("8. Corolario: las tres gravedades salen");
{
  const vistas = new Set<string>();
  const vistosCod = new Set<string>();
  const ctx = ctxBase({ unidades: { "t:1": unidad("t:1", "TTT-111", { anio: null }) }, otras: [{ id: 2, nombre: "Otra", cliente_nombre: "Cliente Ajeno", codigo: null, cliente_erp: null }] });
  for (const presentacion of [PRESENTA, null, "2026-01-01"]) for (const conReq of [true, false]) {
    const lic = licDe({
      requisitos: conReq ? [req("Sin subcontratar", { tipo: "prohibe_subcontratacion" }), req("Manual", null)] : [],
      unidades: [{ clave: "t:1", codigo: "U1", rol: "titular" }],
      secciones: [{ titulo: "S", bloques: [{ tipo: "parrafo", texto: "Cliente Ajeno, flota propia {nada}" }, { tipo: "tabla", columnas: ["a"], filas: [] }] }],
    }, { fecha_presentacion: presentacion, fecha_inicio_servicio: presentacion ? INICIO : null });
    for (const h of revisarLicitacion(lic, ctx).hallazgos) { vistas.add(h.gravedad); vistosCod.add(h.codigo); }
  }
  check(vistas.has("alarma") && vistas.has("aviso") && vistas.has("info"), `las tres gravedades (${[...vistas].join(", ")})`);
  check(vistosCod.size >= 12, `el barrido produce muchos códigos distintos (${vistosCod.size})`);
  // Las claves son estables: aceptar un hallazgo lo marca en la siguiente revisión.
  const lic = licDe({ requisitos: [req("Sin subcontratar", { tipo: "prohibe_subcontratacion" })], unidades: [{ clave: "t:1", codigo: "U1", rol: "titular" }] });
  const h = revisarLicitacion(lic, ctx).hallazgos.find((x) => x.codigo === "unidad_tercerizada_prohibida")!;
  lic.doc.aceptados = [{ clave: h.clave, nota: "El cliente lo autorizó", por: null, en: "" }];
  const r2 = revisarLicitacion(lic, ctx);
  check(r2.hallazgos.find((x) => x.clave === h.clave)?.aceptado?.nota === "El cliente lo autorizó", "(j) el aceptado se adjunta por su clave");
  check(r2.cuenta.alarma === r2.hallazgos.filter((x) => x.gravedad === "alarma" && !x.aceptado).length, "cuenta = abiertos por gravedad");
  check(TIPOS_REGLA.length === 16, "las 16 reglas del catálogo");
  check(r2.referenciaEs === "presentacion" && revisarLicitacion(licDe({}, { fecha_presentacion: null }), ctx).referenciaEs === "hoy", "(k) referencia: presentación o hoy");
}

console.log(`\n${fallos === 0 ? "✓" : "✗"} ${ok} comprobaciones, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
