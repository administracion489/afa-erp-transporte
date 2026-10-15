// ──────────────────────────────────────────────────────────────────────────────
// lib/seguros.ts — Motor PURO de /seguros: una vista DERIVADA de todas las fuentes.
//
// /seguros leía solo la tabla `seguros` y salía vacía, mientras el SOAT/CAT/Todo Riesgo/RC de
// cada placa vive en `documentos_vehiculo`, el de los terceros y el SCTR/Vida Ley de la empresa
// tercerizada en `documentos_tercero`, y el SCTR/Vida Ley de cada persona en su FICHA
// (`conductores` / `personal_administrativo`). Nada de eso se COPIA aquí (regla de oro: un dato,
// una fila autoritativa): este módulo recibe las filas y devuelve la vista. La tabla `seguros`
// queda para las pólizas COLECTIVAS, con sus asegurados en `seguro_cobertura` (N:M).
//
// Sin acceso a la base ni a `fetch`. El que lee es lib/seguros-datos.ts.
// Matriz: npx tsx scripts/prueba-seguros.mts
//
// DECISIONES DECLARADAS
//  · El tipo se resuelve con `tipoCanonico` de lib/documentos-estado.ts — el MISMO clasificador
//    de documentos de todo el ERP. No hay un segundo.
//  · Un «SCTR» a secas (sin decir Salud o Pensión) NO se reparte entre los dos. `tipoCanonico` lo
//    devuelve null por ambiguo y aquí sale como `sctr_sin_precisar`: se ENSEÑA, pero no cumple
//    ni el SCTR Salud ni el SCTR Pensión. Son dos coberturas distintas (EsSalud/EPS y ONP/
//    aseguradora) que pueden contratarse por separado; darlas por cumplidas con un papel que no
//    dice cuál es afirmar una cobertura que nadie leyó. El faltante lo nombra para que se
//    corrija el tipo donde se registró.
//  · Persona (conductor propio o personal administrativo): si está en alguna cobertura de una
//    póliza de ese tipo, GANA la póliza (aunque su baja ya pasó: esa es la verdad); si no, la
//    columna de su ficha; si no, ninguna — nunca se inventa una fecha. Idéntico a la vista
//    v_seguro_persona (seguros-03), y la matriz lo fija. La persona cubierta no sale además con su fila de
//    ficha: la cubre la fila de la póliza (y si la ficha también tiene fecha, `doble_registro`).
//  · Estado: vencido si faltan < 0 días; por vencer de 0 a DIAS_POR_VENCER (30, el que ya usaba
//    la pantalla); vigente después; sin_fecha si no hay vencimiento. «Vence hoy» es por vencer,
//    no vencido (misma convención que lib/documentos-estado.ts).
//  · Los terceros cuentan para el CUMPLIMIENTO, pero su prima no es gasto de AFA: `deAfa` false
//    y `kpisSeguros` no la suma.
//  · Solo flota y personas ACTIVAS entran a `coberturaFaltante`. Una unidad sin ningún documento
//    sale `sin_soat`, nunca verde.
// ──────────────────────────────────────────────────────────────────────────────

import { tipoCanonico, normalizarTipoDoc, docSinVencimiento, diasEntreFechas } from "./documentos-estado";

// ─── CATÁLOGO (se mudó de app/seguros/page.tsx) ──────────────────────────────

export type TipoSeguroConfig = {
  label: string; icon: string; color: string; bg: string;
  categoria: "obligatorio" | "complementario";
  descripcion: string; renovacion: string;
  entidadLabel: string;
};

export const TIPOS_SEGURO: Record<string, TipoSeguroConfig> = {
  soat: {
    label: "SOAT", icon: "🚗", color: "#dc2626", bg: "#fee2e2",
    categoria: "obligatorio",
    descripcion: "Seguro Obligatorio de Accidentes de Tránsito — por vehículo",
    renovacion: "Anual", entidadLabel: "vehículo",
  },
  cat: {
    label: "CAT", icon: "📜", color: "#b45309", bg: "#fef3c7",
    categoria: "obligatorio",
    descripcion: "Certificado Accidentes de Tránsito (alternativa SOAT provincias)",
    renovacion: "Anual", entidadLabel: "vehículo",
  },
  todo_riesgo: {
    label: "Todo Riesgo", icon: "🛡️", color: "#1d4ed8", bg: "#dbeafe",
    categoria: "complementario",
    descripcion: "Cobertura total: robo, choque, incendio, daños a terceros",
    renovacion: "Anual", entidadLabel: "vehículo",
  },
  responsabilidad_civil: {
    label: "Resp. Civil", icon: "⚖️", color: "#7c3aed", bg: "#ede9fe",
    categoria: "complementario",
    descripcion: "Responsabilidad civil frente a terceros — por vehículo o flota",
    renovacion: "Anual", entidadLabel: "vehículo/empresa",
  },
  sctr_salud: {
    label: "SCTR Salud", icon: "🏥", color: "#0f766e", bg: "#f0fdfa",
    categoria: "obligatorio",
    descripcion: "Seguro Complementario Trabajo de Riesgo — Salud (Rimac, Pacífico, La Positiva)",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  sctr_pension: {
    label: "SCTR Pensión", icon: "💼", color: "#166534", bg: "#dcfce7",
    categoria: "obligatorio",
    descripcion: "Seguro Complementario Trabajo de Riesgo — Pensiones (ONP o AFP)",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  vida_ley: {
    label: "Vida Ley", icon: "❤️", color: "#9d174d", bg: "#fdf2f8",
    categoria: "obligatorio",
    descripcion: "Vida Ley D.L. 688 — obligatorio para trabajadores desde el 1er día",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  seguro_carga: {
    label: "Seg. Carga", icon: "📦", color: "#92400e", bg: "#fff7ed",
    categoria: "complementario",
    descripcion: "Seguro de transporte terrestre de carga y mercancías",
    renovacion: "Por servicio/anual", entidadLabel: "empresa",
  },
  patrimonio: {
    label: "Patrimonio", icon: "🏢", color: "#4b5563", bg: "#f3f4f6",
    categoria: "complementario",
    descripcion: "Seguro de bienes muebles, inmuebles, equipos e instalaciones",
    renovacion: "Anual", entidadLabel: "empresa",
  },
  otro: {
    label: "Otro", icon: "📋", color: "#6b7280", bg: "#f9fafb",
    categoria: "complementario",
    descripcion: "Otro tipo de seguro",
    renovacion: "Variable", entidadLabel: "—",
  },
};

/** Clave de seguro de una fila. `sctr_sin_precisar` NO está en TIPOS_SEGURO a propósito (no es
 *  un tipo que se pueda elegir al registrar una póliza: es un dato a corregir). */
export type TipoSeguro = string; // keyof TIPOS_SEGURO | "sctr_sin_precisar"
export const SCTR_SIN_PRECISAR = "sctr_sin_precisar";

export function etiquetaTipoSeguro(tipo: TipoSeguro): string {
  if (tipo === SCTR_SIN_PRECISAR) return "SCTR (sin precisar Salud/Pensión)";
  return TIPOS_SEGURO[tipo]?.label ?? TIPOS_SEGURO.otro.label;
}

/** Canónico de documentos-estado → clave de seguro. Lo que no está aquí NO es un seguro
 *  (Revisión Técnica, TUC…) y no entra a /seguros. */
const SEGURO_DE_CANONICO: Record<string, TipoSeguro> = {
  "SOAT": "soat",
  "CAT": "cat",
  "Seguro Todo Riesgo": "todo_riesgo",
  "Responsabilidad Civil": "responsabilidad_civil",
  "SCTR Salud": "sctr_salud",
  "SCTR Pensión": "sctr_pension",
  "Vida Ley": "vida_ley",
};

/**
 * Tipo de seguro de un texto tecleado: una clave de TIPOS_SEGURO tal cual (las pólizas la
 * guardan así), o el canónico de `tipoCanonico` (los documentos guardan la etiqueta), o
 * `sctr_sin_precisar` para un «SCTR» a secas. null = no es un seguro.
 */
export function tipoSeguroDe(crudo: string | null | undefined): TipoSeguro | null {
  const s = String(crudo ?? "").trim();
  if (!s) return null;
  if (TIPOS_SEGURO[s] || s === SCTR_SIN_PRECISAR) return s;
  const c = tipoCanonico(s);
  if (c) return SEGURO_DE_CANONICO[c.canonico] ?? null;
  const n = normalizarTipoDoc(s);
  if (n === "sctr" || /^sctr( |$)/.test(n)) return SCTR_SIN_PRECISAR;
  return null;
}

// ─── FILAS ──────────────────────────────────────────────────────────────────

export type FuenteSeguro = "documento_vehiculo" | "documento_tercero" | "ficha_conductor" | "ficha_personal" | "poliza";
export const FUENTES_SEGURO: FuenteSeguro[] = ["documento_vehiculo", "documento_tercero", "ficha_conductor", "ficha_personal", "poliza"];

export type ClaseAsegurado = "vehiculo" | "vehiculo_tercero" | "empresa_tercero" | "conductor" | "personal" | "empresa" | "varios";
export type ClaveAsegurado = { clase: Exclude<ClaseAsegurado, "varios" | "empresa">; id: number };
export type Asegurado = { clase: ClaseAsegurado; id: number | null; rotulo: string };
export type EstadoSeguro = "vigente" | "por_vencer" | "vencido" | "sin_fecha";

export const DIAS_POR_VENCER = 30;

export type FilaSeguro = {
  /** clave estable para React: `${fuente}:${origenId}:${tipo}` */
  clave: string;
  fuente: FuenteSeguro;
  origenId: number;
  tipo: TipoSeguro;
  etiqueta: string;
  asegurado: Asegurado;
  aseguradora: string | null;
  numero: string | null;
  inicio: string | null;
  vencimiento: string | null;
  dias: number | null;
  estado: EstadoSeguro;
  prima: number | null;
  cuota: number | null;
  archivo: string | null;
  /** ruta del ERP donde se corrige ESTA fila (la fuente autoritativa) */
  editarEn: string;
  /** false para lo de terceros: cuenta para cumplimiento, no para la prima de AFA */
  deAfa: boolean;
  /** solo pólizas: cuántos asegurados vigentes cubre */
  cubiertos?: number;
  /** solo pólizas: a quién cubre hoy (para el cumplimiento). Las inclusiones SOLICITADAS no. */
  cubre?: ClaveAsegurado[];
  /** todos los tipos que cubre la fila (una póliza SCTR Salud + Pensión + Vida Ley es UNA fila);
   *  en documentos y fichas es `[tipo]`. `tipo` sigue siendo el principal. */
  tipos: TipoSeguro[];
  /** solo pólizas: inclusiones pedidas al bróker y aún sin confirmar (0 en el resto) */
  solicitados: number;
};

export const EDITAR_EN: Record<FuenteSeguro, string> = {
  documento_vehiculo: "/vehiculos",
  documento_tercero: "/tercerizadas",
  ficha_conductor: "/conductores",
  ficha_personal: "/personal-administrativo",
  poliza: "/seguros",
};

/** Estado coherente con `dias`. Puro: el «hoy» lo pone quien llama. */
export function estadoDe(vencimiento: string | null | undefined, hoy: string, tipo?: string | null):
  { dias: number | null; estado: EstadoSeguro } {
  if (tipo && docSinVencimiento(tipo)) return { dias: null, estado: "vigente" };
  const dias = vencimiento ? diasEntreFechas(hoy, vencimiento) : null;
  if (dias === null) return { dias: null, estado: "sin_fecha" };
  if (dias < 0) return { dias, estado: "vencido" };
  if (dias <= DIAS_POR_VENCER) return { dias, estado: "por_vencer" };
  return { dias, estado: "vigente" };
}

const fecha = (v: unknown): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const txt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

/** Nombres para rotular asegurados (los arma el lector). */
export type Directorio = {
  vehiculos?: Map<number, string>;          // id → placa
  vehiculosTercero?: Map<number, string>;   // id → placa
  empresasTercero?: Map<number, string>;    // id → razón social
  conductores?: Map<number, string>;
  personal?: Map<number, string>;
};

function rotuloDe(dir: Directorio, k: ClaveAsegurado): string {
  const m = k.clase === "vehiculo" ? dir.vehiculos
    : k.clase === "vehiculo_tercero" ? dir.vehiculosTercero
    : k.clase === "empresa_tercero" ? dir.empresasTercero
    : k.clase === "conductor" ? dir.conductores : dir.personal;
  return m?.get(k.id) ?? `${k.clase.replace("_", " ")} #${k.id}`;
}

function armar(
  base: Omit<FilaSeguro, "clave" | "etiqueta" | "dias" | "estado" | "tipos" | "solicitados"> & { tipos?: TipoSeguro[]; solicitados?: number },
  hoy: string,
): FilaSeguro {
  const { dias, estado } = estadoDe(base.vencimiento, hoy);
  const tipos = base.tipos && base.tipos.length ? base.tipos : [base.tipo];
  return {
    ...base, tipos, solicitados: base.solicitados ?? 0,
    clave: `${base.fuente}:${base.origenId}:${base.tipo}`,
    etiqueta: tipos.length > 1 ? etiquetaDeTipos(tipos) : etiquetaTipoSeguro(base.tipo), dias, estado,
  };
}

/** Rótulo de una póliza de varios tipos: «SCTR Salud + Pensión + Vida Ley» (orden fijo de
 *  TIPOS_PERSONA; los dos SCTR se escriben juntos para no repetir «SCTR»). */
export function etiquetaDeTipos(tipos: TipoSeguro[]): string {
  const orden = ["sctr_salud", "sctr_pension", "vida_ley"];
  const ts = [...new Set(tipos)].sort((a, b) => {
    const ia = orden.indexOf(a), ib = orden.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const partes: string[] = [];
  if (ts.includes("sctr_salud") && ts.includes("sctr_pension")) partes.push("SCTR Salud + Pensión");
  for (const t of ts) {
    if ((t === "sctr_salud" || t === "sctr_pension") && partes[0] === "SCTR Salud + Pensión") continue;
    partes.push(etiquetaTipoSeguro(t));
  }
  return partes.join(" + ");
}

// ── Documentos de vehículo propio ───────────────────────────────────────────

export type DocVehiculoRow = {
  id: number; vehiculo_id: number | null; tipo: string | null; numero?: string | null;
  fecha_emision?: string | null; fecha_vencimiento?: string | null;
  entidad_emisora?: string | null; archivo_url?: string | null;
};

export function filasDeDocumentosVehiculo(docs: DocVehiculoRow[], dir: Directorio, hoy: string): FilaSeguro[] {
  const out: FilaSeguro[] = [];
  for (const d of docs || []) {
    const tipo = tipoSeguroDe(d.tipo);
    if (!tipo || d.vehiculo_id == null) continue;
    const k: ClaveAsegurado = { clase: "vehiculo", id: Number(d.vehiculo_id) };
    out.push(armar({
      fuente: "documento_vehiculo", origenId: Number(d.id), tipo,
      asegurado: { ...k, rotulo: rotuloDe(dir, k) },
      aseguradora: txt(d.entidad_emisora), numero: txt(d.numero),
      inicio: fecha(d.fecha_emision), vencimiento: fecha(d.fecha_vencimiento),
      prima: null, cuota: null, archivo: txt(d.archivo_url),
      editarEn: EDITAR_EN.documento_vehiculo, deAfa: true,
    }, hoy));
  }
  return out;
}

// ── Documentos de tercero (por placa, o de la empresa si vehiculo_id es null) ─

export type DocTerceroRow = DocVehiculoRow & { empresa_id: number | null };

export function filasDeDocumentosTercero(docs: DocTerceroRow[], dir: Directorio, hoy: string): FilaSeguro[] {
  const out: FilaSeguro[] = [];
  for (const d of docs || []) {
    const tipo = tipoSeguroDe(d.tipo);
    if (!tipo) continue;
    let k: ClaveAsegurado;
    if (d.vehiculo_id != null) k = { clase: "vehiculo_tercero", id: Number(d.vehiculo_id) };
    else if (d.empresa_id != null) k = { clase: "empresa_tercero", id: Number(d.empresa_id) };
    else continue;
    out.push(armar({
      fuente: "documento_tercero", origenId: Number(d.id), tipo,
      asegurado: { ...k, rotulo: rotuloDe(dir, k) },
      aseguradora: txt(d.entidad_emisora), numero: txt(d.numero),
      inicio: fecha(d.fecha_emision), vencimiento: fecha(d.fecha_vencimiento),
      prima: null, cuota: null, archivo: txt(d.archivo_url),
      editarEn: EDITAR_EN.documento_tercero, deAfa: false,
    }, hoy));
  }
  return out;
}

// ── Pólizas colectivas (`seguros` + `seguro_cobertura`) ──────────────────────

export type PolizaRow = {
  id: number; tipo: string | null; aseguradora?: string | null; numero_poliza?: string | null;
  titular?: string | null; vehiculo_id?: number | null;
  /** accesoria (seguros-01): póliza individual de una unidad de tercero */
  vehiculo_tercero_id?: number | null;
  alcance?: "individual" | "colectiva" | null;
  /** accesoria (seguros-04a): los tipos de PERSONA que cubre (⊆ sctr_salud, sctr_pension,
   *  vida_ley, e incluye `tipo`). null/vacío = solo `tipo`, lo de siempre. */
  coberturas?: string[] | null;
  fecha_inicio?: string | null; fecha_vencimiento?: string | null;
  prima_total?: number | null; cuota_mensual?: number | null; archivo_url?: string | null;
};

export type EstadoCobertura = "solicitada" | "incluida" | "excluida";

export type CoberturaRow = {
  id?: number;
  seguro_id: number;
  conductor_id?: number | null; personal_administrativo_id?: number | null;
  vehiculo_id?: number | null; vehiculo_tercero_id?: number | null;
  desde?: string | null; hasta?: string | null;
  /** accesorias (seguros-04a). estado null = incluida (lo de siempre). Una 'solicitada' es una
   *  inclusión pedida al bróker que la aseguradora aún no confirmó: NO cubre. */
  estado?: EstadoCobertura | string | null;
  solicitada_en?: string | null;
  constancia_url?: string | null;
  nota?: string | null;
};

/** Tipos que cubre una póliza: `coberturas` si trae alguno, si no `[tipo]` (sin tipo, ninguno).
 *  Texto CRUDO, como la vista: `tipo = any(coberturas)`. */
export function tiposDePoliza(p: Pick<PolizaRow, "tipo" | "coberturas">): string[] {
  const cs = Array.isArray(p.coberturas) ? p.coberturas.map((c) => String(c ?? "").trim()).filter(Boolean) : [];
  if (cs.length) return [...new Set(cs)];
  return p.tipo ? [String(p.tipo)] : [];
}

/** null (o un valor que el CHECK no admite) = incluida: el comportamiento de antes de seguros-04a. */
export function estadoCobertura(c: Pick<CoberturaRow, "estado">): EstadoCobertura {
  const e = String(c.estado ?? "").trim().toLowerCase();
  return e === "solicitada" ? "solicitada" : e === "excluida" ? "excluida" : "incluida";
}

/** Desde cuándo cubre: coalesce(cobertura.desde, póliza.fecha_inicio). null = no se sabe (cubre). */
export function inicioEfectivo(c: Pick<CoberturaRow, "desde">, p: Pick<PolizaRow, "fecha_inicio"> | null | undefined): string | null {
  return fecha(c.desde) ?? fecha(p?.fecha_inicio);
}

export function claveDeCobertura(c: CoberturaRow): ClaveAsegurado | null {
  if (c.conductor_id != null) return { clase: "conductor", id: Number(c.conductor_id) };
  if (c.personal_administrativo_id != null) return { clase: "personal", id: Number(c.personal_administrativo_id) };
  if (c.vehiculo_id != null) return { clase: "vehiculo", id: Number(c.vehiculo_id) };
  if (c.vehiculo_tercero_id != null) return { clase: "vehiculo_tercero", id: Number(c.vehiculo_tercero_id) };
  return null;
}

/** ¿La cobertura vale HOY? Sin `hoy` no se juzga la ventana (vale siempre). */
export function coberturaVigente(c: CoberturaRow, hoy?: string): boolean {
  if (!hoy) return true;
  const d = fecha(c.desde), h = fecha(c.hasta);
  if (d && d > hoy) return false;
  if (h && h < hoy) return false;
  return true;
}

const mismaClave = (a: ClaveAsegurado, b: { clase: string; id: number | null }) => a.clase === b.clase && a.id === b.id;

/** Asegurados vigentes de una póliza: los de `seguro_cobertura`; si no tiene ninguna fila de
 *  cobertura (ni vieja), el `vehiculo_id` de la propia póliza (el registro antiguo). */
export function cubiertosDePoliza(p: PolizaRow, coberturas: CoberturaRow[], hoy?: string): ClaveAsegurado[] {
  const suyas = (coberturas || []).filter((c) => Number(c.seguro_id) === Number(p.id));
  if (suyas.length === 0) {
    if (p.vehiculo_id != null) return [{ clase: "vehiculo", id: Number(p.vehiculo_id) }];
    if (p.vehiculo_tercero_id != null) return [{ clase: "vehiculo_tercero", id: Number(p.vehiculo_tercero_id) }];
    return [];
  }
  const out: ClaveAsegurado[] = [];
  for (const c of suyas) {
    if (estadoCobertura(c) === "solicitada") continue; // pedida, no confirmada: no cubre
    if (!coberturaVigente(c, hoy)) continue;
    const k = claveDeCobertura(c);
    if (k && !out.some((o) => mismaClave(o, k))) out.push(k);
  }
  return out;
}

/** Inclusiones pedidas al bróker y aún sin confirmar de una póliza. */
export function solicitadosDePoliza(p: PolizaRow, coberturas: CoberturaRow[]): number {
  return (coberturas || []).filter((c) => Number(c.seguro_id) === Number(p.id) && estadoCobertura(c) === "solicitada").length;
}

/** UNA fila por póliza, aunque cubra varios tipos (la prima se cuenta una vez). */
export function filasDePolizas(polizas: PolizaRow[], coberturas: CoberturaRow[], dir: Directorio, hoy: string): FilaSeguro[] {
  return (polizas || []).map((p) => {
    const tipo = tipoSeguroDe(p.tipo) ?? "otro";
    const extra = tiposDePoliza(p).map((t) => tipoSeguroDe(t)).filter((t): t is string => !!t);
    const tipos = [tipo, ...extra.filter((t) => t !== tipo)];
    const cubre = cubiertosDePoliza(p, coberturas, hoy);
    const asegurado: Asegurado = cubre.length === 1
      ? { ...cubre[0], rotulo: rotuloDe(dir, cubre[0]) }
      : cubre.length > 1
        ? { clase: "varios", id: null, rotulo: `${cubre.length} asegurados` }
        : { clase: "empresa", id: null, rotulo: txt(p.titular) ?? "Empresa" };
    return armar({
      fuente: "poliza", origenId: Number(p.id), tipo, asegurado,
      aseguradora: txt(p.aseguradora), numero: txt(p.numero_poliza),
      inicio: fecha(p.fecha_inicio), vencimiento: fecha(p.fecha_vencimiento),
      prima: num(p.prima_total), cuota: num(p.cuota_mensual), archivo: txt(p.archivo_url),
      editarEn: EDITAR_EN.poliza, deAfa: true, cubiertos: cubre.length, cubre,
      tipos, solicitados: solicitadosDePoliza(p, coberturas),
    }, hoy);
  });
}

// ── Personas (fichas) ───────────────────────────────────────────────────────

export type PersonaFicha = {
  clase: "conductor" | "personal";
  id: number;
  nombre: string;
  activo: boolean;
  sctr_salud_venc?: string | null;
  sctr_pension_venc?: string | null;
  vida_ley?: boolean | null;
  vida_ley_venc?: string | null;
};

export type TipoPersona = "sctr_salud" | "sctr_pension" | "vida_ley";
export const TIPOS_PERSONA: TipoPersona[] = ["sctr_salud", "sctr_pension", "vida_ley"];

/** Fecha de la ficha para ese tipo — el MISMO `case` de v_seguro_persona: Vida Ley solo cuenta
 *  con la casilla `vida_ley` marcada (la regla de /conductores y /personal). */
export function fechaDeFicha(p: PersonaFicha, tipo: TipoPersona): string | null {
  if (tipo === "sctr_salud") return fecha(p.sctr_salud_venc);
  if (tipo === "sctr_pension") return fecha(p.sctr_pension_venc);
  return p.vida_ley === true ? fecha(p.vida_ley_venc) : null;
}

export type InclusionPendiente = {
  /** 'solicitada': pedida al bróker, sin confirmar · 'por_iniciar': confirmada, empieza después */
  estado: "solicitada" | "por_iniciar";
  /** solicitada → solicitada_en · por_iniciar → inicio efectivo */
  fecha: string | null;
  seguroId: number;
};

export type VencimientoPersona = {
  vencimiento: string | null;
  /** 'pendiente' = hay una inclusión en trámite: NO está cubierto y la ficha NO manda */
  fuente: "poliza" | "ficha" | "pendiente" | null;
  seguroId?: number;
  inclusion?: InclusionPendiente;
};

/**
 * EQUIVALENTE EXACTO de la vista `v_seguro_persona` (supabase/seguros-04b-vista-persona.sql; antes seguros-03); la matriz lo
 * fija con un oráculo literal. Por persona × tipo, gana el primer paso:
 *  1) CUBRE por póliza: coberturas no 'solicitada' de pólizas cuyo `tiposDePoliza` incluye el
 *     tipo, con inicio efectivo (coalesce(desde, fecha_inicio)) null o ≤ hoy y fin
 *     (coalesce(hasta, fecha_vencimiento)) ≥ hoy → el fin más lejano (empate: id de póliza mayor).
 *  2) PENDIENTE: una INCLUIDA con inicio > hoy ('por_iniciar', gana: ya está confirmada; la de
 *     inicio más cercano; una 'excluida' con inicio futuro no cuenta en ningún paso) o una 'solicitada' ('solicitada', la de solicitud más antigua; sin fecha al
 *     final). Desempate: id de póliza mayor. vencimiento null y la FICHA NO MANDA.
 *  3) Póliza vencida o de baja (no solicitada, inicio ≤ hoy o null): el fin más lejano aunque pasado
 *     — la verdad, no se cae a la ficha.
 *  4) FICHA (Vida Ley solo con la casilla marcada). 5) null — nunca se inventa una fecha.
 * Una cobertura sin ningún fin (ni hasta ni fecha_vencimiento) no cuenta en 1 ni en 3, como antes.
 * Sin estados, sin `coberturas` y sin inicios futuros: byte a byte la regla de seguros-03.
 */
export function vencimientoPersona(
  persona: PersonaFicha, polizas: PolizaRow[], coberturas: CoberturaRow[], tipo: TipoPersona, hoy: string,
): VencimientoPersona {
  const porId = new Map<number, PolizaRow>();
  for (const p of polizas || []) porId.set(Number(p.id), p);
  let act: { fin: string; sid: number } | null = null;
  let ven: { fin: string; sid: number } | null = null;
  let ini: { f: string; sid: number } | null = null;
  let sol: { f: string | null; sid: number } | null = null;
  const mejorFin = (a: { fin: string; sid: number } | null, fin: string, sid: number) =>
    a === null || fin > a.fin || (fin === a.fin && sid > a.sid) ? { fin, sid } : a;
  for (const c of coberturas || []) {
    const p = porId.get(Number(c.seguro_id));
    if (!p || !tiposDePoliza(p).includes(tipo)) continue;
    const suya = persona.clase === "conductor"
      ? c.conductor_id != null && Number(c.conductor_id) === persona.id
      : c.personal_administrativo_id != null && Number(c.personal_administrativo_id) === persona.id;
    if (!suya) continue;
    const sid = Number(p.id);
    if (estadoCobertura(c) === "solicitada") {
      const f = fecha(c.solicitada_en);
      // la más antigua primero; sin fecha al final; empate id mayor
      if (sol === null || (f !== null && (sol.f === null || f < sol.f)) || (f === sol.f && sid > sol.sid)) sol = { f, sid };
      continue;
    }
    const i0 = inicioEfectivo(c, p);
    if (i0 !== null && i0 > hoy) {
      // solo una INCLUIDA con inicio futuro está por iniciar; una excluida que aún no empezó no
      // cuenta para nada (la vista: `est = 'incluida' and ini > hoy`)
      if (estadoCobertura(c) === "incluida" && (ini === null || i0 < ini.f || (i0 === ini.f && sid > ini.sid))) ini = { f: i0, sid };
      continue;
    }
    const fin = fecha(c.hasta) ?? fecha(p.fecha_vencimiento);
    if (!fin) continue;
    if (fin >= hoy) act = mejorFin(act, fin, sid);
    else ven = mejorFin(ven, fin, sid);
  }
  if (act) return { vencimiento: act.fin, fuente: "poliza", seguroId: act.sid };
  if (ini) return { vencimiento: null, fuente: "pendiente", inclusion: { estado: "por_iniciar", fecha: ini.f, seguroId: ini.sid } };
  if (sol) return { vencimiento: null, fuente: "pendiente", inclusion: { estado: "solicitada", fecha: sol.f, seguroId: sol.sid } };
  if (ven) return { vencimiento: ven.fin, fuente: "poliza", seguroId: ven.sid };
  const f = fechaDeFicha(persona, tipo);
  return f ? { vencimiento: f, fuente: "ficha" } : { vencimiento: null, fuente: null };
}

/** Columna de la ficha del conductor → tipo de seguro de persona. Lo que no está aquí (licencia,
 *  examen médico…) no es un seguro y su fecha sale siempre de la ficha. */
export const TIPO_DE_COLUMNA_FICHA: Record<string, TipoPersona> = {
  sctr_salud_venc: "sctr_salud",
  sctr_pension_venc: "sctr_pension",
  vida_ley_venc: "vida_ley",
};

/**
 * Vencimiento que usan el tick (bloque 6, `doc_vence`) y el login del app del conductor: la
 * regla de `vencimientoPersona` (póliza → pendiente → póliza vencida); si no, el valor CRUDO de la
 * ficha, tal cual lo usaban hasta hoy.
 *  · `polizas`/`coberturas` en null = no se pudieron leer (o falta la migración): byte a byte el
 *    comportamiento anterior, la ficha.
 *  · PENDIENTE (inclusión solicitada o por iniciar) → vencimiento null y fuente 'pendiente': no
 *    está cubierto, y la ficha NO lo tapa. El tick salta un null (no hay «por vencer» que avisar).
 *  · La rama de ficha NO aplica la casilla `vida_ley` de `fechaDeFicha`: esos dos caminos nunca
 *    la miraron, y cambiarlo aquí dejaría de avisar un Vida Ley que hoy se avisa.
 *  · Una baja de la póliza (hasta pasado) da su fecha vencida y NO cae a la ficha — la verdad.
 */
export function vencimientoFichaOPoliza(
  persona: { clase: "conductor" | "personal"; id: number },
  columna: string,
  valorFicha: string | null | undefined,
  polizas: PolizaRow[] | null,
  coberturas: CoberturaRow[] | null,
  hoy: string,
): { vencimiento: string | null; fuente: "poliza" | "ficha" | "pendiente"; seguroId?: number; inclusion?: InclusionPendiente } {
  const tipo = TIPO_DE_COLUMNA_FICHA[columna];
  const crudo = valorFicha ?? null;
  if (!tipo || !polizas || !coberturas) return { vencimiento: crudo, fuente: "ficha" };
  const v = vencimientoPersona({ clase: persona.clase, id: persona.id, nombre: "", activo: true }, polizas, coberturas, tipo, hoy);
  if (v.fuente === "poliza") return { vencimiento: v.vencimiento, fuente: "poliza", seguroId: v.seguroId };
  if (v.fuente === "pendiente") return { vencimiento: null, fuente: "pendiente", inclusion: v.inclusion };
  return { vencimiento: crudo, fuente: "ficha" };
}

/** Una fila por persona y tipo con dato EN SU FICHA, salvo que una póliza la cubra (entonces
 *  la cubre la fila de la póliza y no se duplica). */
export function filasDeFichas(
  personas: PersonaFicha[], polizas: PolizaRow[], coberturas: CoberturaRow[], hoy: string,
): FilaSeguro[] {
  const out: FilaSeguro[] = [];
  for (const p of personas || []) {
    for (const tipo of TIPOS_PERSONA) {
      const v = vencimientoPersona(p, polizas, coberturas, tipo, hoy);
      if (v.fuente !== "ficha") continue; // póliza o inclusión pendiente: la ficha no sale
      const fuente: FuenteSeguro = p.clase === "conductor" ? "ficha_conductor" : "ficha_personal";
      out.push(armar({
        fuente, origenId: p.id, tipo,
        asegurado: { clase: p.clase, id: p.id, rotulo: p.nombre },
        aseguradora: null, numero: null, inicio: null, vencimiento: v.vencimiento,
        prima: null, cuota: null, archivo: null,
        editarEn: EDITAR_EN[fuente], deAfa: true,
      }, hoy));
    }
  }
  return out;
}

// ─── KPIs ───────────────────────────────────────────────────────────────────

export type KpisSeguros = {
  total: number; vigentes: number; porVencer: number; vencidos: number; sinFecha: number;
  obligatorios: number; complementarios: number;
  /** solo lo que paga AFA (deAfa) */
  primaTotal: number; cuotaTotal: number;
};

export function kpisSeguros(filas: FilaSeguro[]): KpisSeguros {
  const k: KpisSeguros = { total: 0, vigentes: 0, porVencer: 0, vencidos: 0, sinFecha: 0, obligatorios: 0, complementarios: 0, primaTotal: 0, cuotaTotal: 0 };
  for (const f of filas || []) {
    k.total++;
    if (f.estado === "vigente") k.vigentes++;
    else if (f.estado === "por_vencer") k.porVencer++;
    else if (f.estado === "vencido") k.vencidos++;
    else k.sinFecha++;
    // Una póliza de varios tipos es UNA fila (su prima se cuenta una vez) y es obligatoria si
    // cualquiera de sus tipos lo es.
    const tipos = f.tipos && f.tipos.length ? f.tipos : [f.tipo];
    const obligatoria = tipos.some((t) => t === SCTR_SIN_PRECISAR || TIPOS_SEGURO[t]?.categoria === "obligatorio");
    if (obligatoria) k.obligatorios++; else k.complementarios++;
    if (f.deAfa) { k.primaTotal += f.prima ?? 0; k.cuotaTotal += f.cuota ?? 0; }
  }
  k.primaTotal = Math.round(k.primaTotal * 100) / 100;
  k.cuotaTotal = Math.round(k.cuotaTotal * 100) / 100;
  return k;
}

// ─── COBERTURA FALTANTE ─────────────────────────────────────────────────────

export type CodigoFaltante =
  | "sin_soat" | "soat_vencido" | "soat_sin_fecha"
  | "sctr_salud_faltante" | "sctr_pension_faltante" | "sctr_vencido"
  | "vida_ley_faltante" | "vida_ley_vencida"
  | "inclusion_solicitada" | "inclusion_por_iniciar"
  | "doble_registro";

/** `alarma` declarada PEGADA al código: solo doble_registro no alarma (es un dato redundante,
 *  no una persona o un bus sin seguro). */
export const CODIGOS_FALTANTE: Record<CodigoFaltante, { titulo: string; alarma: boolean }> = {
  sin_soat:              { titulo: "Sin SOAT/CAT registrado",   alarma: true },
  soat_vencido:          { titulo: "SOAT/CAT vencido",          alarma: true },
  soat_sin_fecha:        { titulo: "SOAT/CAT sin vencimiento",  alarma: true },
  sctr_salud_faltante:   { titulo: "Sin SCTR Salud",            alarma: true },
  sctr_pension_faltante: { titulo: "Sin SCTR Pensión",          alarma: true },
  sctr_vencido:          { titulo: "SCTR vencido",              alarma: true },
  vida_ley_faltante:     { titulo: "Sin Vida Ley",              alarma: true },
  vida_ley_vencida:      { titulo: "Vida Ley vencida",          alarma: true },
  inclusion_solicitada:  { titulo: "Inclusión pedida, sin activar", alarma: true },
  inclusion_por_iniciar: { titulo: "Inclusión aún no empieza",  alarma: true },
  doble_registro:        { titulo: "Registrado dos veces",      alarma: false },
};

export type Faltante = {
  codigo: CodigoFaltante;
  alarma: boolean;
  asegurado: Asegurado;
  tipo: TipoSeguro;
  texto: string;
  /** dónde se corrige */
  arreglo: string;
  vencimiento?: string | null;
  /** inclusiones: todos los tipos de esa póliza en trámite para esa persona, y la póliza */
  tipos?: TipoSeguro[];
  seguroId?: number;
  /** inclusiones: fecha de solicitud (solicitada) o de inicio (por_iniciar) */
  fechaInclusion?: string | null;
};

export type UnidadFlota = { id: number; placa: string; estado?: string | null; empresa_id?: number | null; empresa?: string | null };

/** Activo = estado distinto de inactivo / de_baja (vacío cuenta como activo). */
export function estaActivo(estado: string | null | undefined): boolean {
  const e = String(estado ?? "").trim().toLowerCase();
  return e !== "inactivo" && e !== "de_baja" && e !== "baja";
}

const fmt = (f: string | null | undefined) => {
  const s = fecha(f); if (!s) return "—";
  const [a, m, d] = s.split("-"); return `${d}/${m}/${a}`;
};
const fmtDM = (f: string | null | undefined) => {
  const s = fecha(f); if (!s) return "—";
  const [, m, d] = s.split("-"); return `${d}/${m}`;
};

function falta(codigo: CodigoFaltante, asegurado: Asegurado, tipo: TipoSeguro, texto: string, arreglo: string, vencimiento?: string | null): Faltante {
  return { codigo, alarma: CODIGOS_FALTANTE[codigo].alarma, asegurado, tipo, texto, arreglo, vencimiento };
}

/** Filas que cubren a un asegurado (directas o por póliza). */
function filasDe(filas: FilaSeguro[], k: ClaveAsegurado, tipos: TipoSeguro[]): FilaSeguro[] {
  return filas.filter((f) => (f.tipos && f.tipos.length ? f.tipos : [f.tipo]).some((t) => tipos.includes(t)) && (
    mismaClave(k, f.asegurado) || (f.cubre ?? []).some((c) => mismaClave(c, k))));
}

const VALIDO = (f: FilaSeguro) => f.estado === "vigente" || f.estado === "por_vencer";
const mejorVenc = (fs: FilaSeguro[]) => fs.map((f) => f.vencimiento).filter(Boolean).sort().pop() ?? null;

function juzgarUnidad(k: ClaveAsegurado, rotulo: string, filas: FilaSeguro[], arreglo: string, out: Faltante[]) {
  const a: Asegurado = { ...k, rotulo };
  const fs = filasDe(filas, k, ["soat", "cat"]);
  if (fs.length === 0) { out.push(falta("sin_soat", a, "soat", `${rotulo} no tiene SOAT ni CAT registrado.`, arreglo)); return; }
  if (!fs.some(VALIDO)) {
    if (fs.some((f) => f.estado === "sin_fecha")) out.push(falta("soat_sin_fecha", a, "soat", `${rotulo} tiene SOAT/CAT sin fecha de vencimiento: no se puede saber si está vigente.`, arreglo));
    else { const v = mejorVenc(fs); out.push(falta("soat_vencido", a, "soat", `El SOAT/CAT de ${rotulo} venció el ${fmt(v)}.`, arreglo, v)); }
  }
  const fuentes = new Set(fs.map((f) => f.fuente));
  if (fuentes.size > 1) out.push(falta("doble_registro", a, "soat", `El SOAT/CAT de ${rotulo} está registrado en ${fuentes.size} sitios (${[...fuentes].join(", ")}); vale el de vencimiento más lejano.`, arreglo));
}

const ETQ: Record<TipoPersona, string> = { sctr_salud: "SCTR Salud", sctr_pension: "SCTR Pensión", vida_ley: "Vida Ley" };
const COD_FALTA: Record<TipoPersona, CodigoFaltante> = { sctr_salud: "sctr_salud_faltante", sctr_pension: "sctr_pension_faltante", vida_ley: "vida_ley_faltante" };
const COD_VENCIDO: Record<TipoPersona, CodigoFaltante> = { sctr_salud: "sctr_vencido", sctr_pension: "sctr_vencido", vida_ley: "vida_ley_vencida" };

/**
 * Qué falta para estar cubierto. Solo flota y personas ACTIVAS.
 *  · Unidad (propia o de tercero): SOAT o CAT vigente. Sin ningún documento → sin_soat.
 *  · Persona (conductor propio / personal): SCTR Salud, SCTR Pensión y Vida Ley, con la cascada
 *    póliza → ficha. Si la ficha tiene fecha y además la cubre una póliza → doble_registro.
 *  · Empresa tercerizada con unidades activas: sus SCTR y Vida Ley en documentos_tercero.
 *  Un «SCTR» sin precisar NO cumple ninguno de los dos; el texto lo nombra.
 */
export function coberturaFaltante(
  flotaPropia: UnidadFlota[], flotaTercero: UnidadFlota[], personas: PersonaFicha[],
  filas: FilaSeguro[], hoy: string,
  opts: { polizas?: PolizaRow[]; coberturas?: CoberturaRow[] } = {},
): Faltante[] {
  const out: Faltante[] = [];
  for (const u of flotaPropia || []) if (estaActivo(u.estado)) juzgarUnidad({ clase: "vehiculo", id: u.id }, u.placa, filas, `${EDITAR_EN.documento_vehiculo} → documentos de ${u.placa}`, out);
  const empresas = new Map<number, string>();
  for (const u of flotaTercero || []) {
    if (!estaActivo(u.estado)) continue;
    juzgarUnidad({ clase: "vehiculo_tercero", id: u.id }, u.placa, filas, `${EDITAR_EN.documento_tercero} → documentos de ${u.placa}`, out);
    if (u.empresa_id != null) empresas.set(Number(u.empresa_id), u.empresa ?? `Empresa #${u.empresa_id}`);
  }

  // Empresas tercerizadas: sus documentos (de la empresa o de cualquiera de sus placas).
  for (const [eid, nombre] of empresas) {
    const a: Asegurado = { clase: "empresa_tercero", id: eid, rotulo: nombre };
    const placasDe = new Set((flotaTercero || []).filter((u) => Number(u.empresa_id) === eid).map((u) => u.id));
    const suyas = filas.filter((f) => f.fuente === "documento_tercero" && (
      (f.asegurado.clase === "empresa_tercero" && f.asegurado.id === eid) ||
      (f.asegurado.clase === "vehiculo_tercero" && f.asegurado.id != null && placasDe.has(f.asegurado.id))));
    const sinPrecisar = suyas.some((f) => f.tipo === SCTR_SIN_PRECISAR);
    for (const t of TIPOS_PERSONA) {
      const fs = suyas.filter((f) => f.tipo === t);
      const arreglo = `${EDITAR_EN.documento_tercero} → documentos de ${nombre}`;
      if (fs.length === 0) {
        const extra = t !== "vida_ley" && sinPrecisar ? " Hay un «SCTR» registrado sin decir si es Salud o Pensión: corrige su tipo." : "";
        out.push(falta(COD_FALTA[t], a, t, `${nombre} no tiene ${ETQ[t]} registrado.${extra}`, arreglo));
      } else if (!fs.some(VALIDO) && !fs.some((f) => f.estado === "sin_fecha")) {
        const v = mejorVenc(fs);
        out.push(falta(COD_VENCIDO[t], a, t, `El ${ETQ[t]} de ${nombre} venció el ${fmt(v)}.`, arreglo, v));
      }
    }
  }

  // Personas.
  const porIdPol = new Map<number, PolizaRow>();
  for (const pz of opts.polizas ?? []) porIdPol.set(Number(pz.id), pz);
  for (const p of personas || []) {
    if (!p.activo) continue;
    const a: Asegurado = { clase: p.clase, id: p.id, rotulo: p.nombre };
    const fichaEn = p.clase === "conductor" ? EDITAR_EN.ficha_conductor : EDITAR_EN.ficha_personal;
    // Inclusiones en trámite: una por persona × póliza × código, con todos sus tipos.
    const inclusiones = new Map<string, Faltante>();
    for (const t of TIPOS_PERSONA) {
      const v = vencimientoPersona(p, opts.polizas ?? [], opts.coberturas ?? [], t, hoy);
      if (v.fuente === "pendiente" && v.inclusion) {
        const inc = v.inclusion;
        const codigo: CodigoFaltante = inc.estado === "solicitada" ? "inclusion_solicitada" : "inclusion_por_iniciar";
        const clave = `${inc.seguroId}:${codigo}`;
        const ya = inclusiones.get(clave);
        if (ya) { ya.tipos!.push(t); continue; }
        inclusiones.set(clave, { ...falta(codigo, a, t, "", `${EDITAR_EN.poliza} → póliza #${inc.seguroId}`),
          tipos: [t], seguroId: inc.seguroId, fechaInclusion: inc.fecha });
        continue;
      }
      const arreglo = v.fuente === "poliza" ? `${EDITAR_EN.poliza} → póliza #${v.seguroId}` : `${fichaEn} → ficha de ${p.nombre}`;
      if (v.fuente === null) {
        const sinFechaVL = t === "vida_ley" && p.vida_ley === true ? " (Vida Ley marcada pero sin fecha de vencimiento)" : "";
        out.push(falta(COD_FALTA[t], a, t, `${p.nombre} no tiene ${ETQ[t]}: ni póliza que lo cubra ni fecha en su ficha${sinFechaVL}.`, `${fichaEn} → ficha de ${p.nombre}, o inclúyelo en una póliza en ${EDITAR_EN.poliza}`));
        continue;
      }
      const d = diasEntreFechas(hoy, v.vencimiento);
      if (d !== null && d < 0) out.push(falta(COD_VENCIDO[t], a, t, `El ${ETQ[t]} de ${p.nombre} venció el ${fmt(v.vencimiento)}.`, arreglo, v.vencimiento));
      if (v.fuente === "poliza") {
        const f = fechaDeFicha(p, t);
        if (f) out.push(falta("doble_registro", a, t, `${p.nombre}: la ficha dice ${ETQ[t]} hasta ${fmt(f)} y la póliza #${v.seguroId} hasta ${fmt(v.vencimiento)}; vale la póliza.`, `${fichaEn} → ficha de ${p.nombre} (vacía la fecha)`));
      }
    }
    for (const f of inclusiones.values()) {
      const pol = porIdPol.get(Number(f.seguroId));
      const que = `${etiquetaDeTipos(f.tipos!)}${pol?.numero_poliza ? ` (póliza ${pol.numero_poliza})` : ` (póliza #${f.seguroId})`}`;
      if (f.codigo === "inclusion_solicitada") {
        const n = f.fechaInclusion ? diasEntreFechas(f.fechaInclusion, hoy) : null;
        f.texto = f.fechaInclusion
          ? `${p.nombre}: inclusión al ${que} solicitada al bróker el ${fmtDM(f.fechaInclusion)} (${n} día${n === 1 ? "" : "s"}), sin activar. No está cubierto.`
          : `${p.nombre}: inclusión al ${que} solicitada al bróker, sin activar. No está cubierto.`;
      } else {
        f.texto = `${p.nombre}: incluido en el ${que} desde el ${fmtDM(f.fechaInclusion)}: no lo asignes antes.`;
      }
      out.push(f);
    }
  }
  return out;
}

// ─── SCTR PARA ASIGNAR UN SERVICIO ──────────────────────────────────────────

export type EstadoSctr = "activo" | "pendiente_inclusion" | "por_iniciar" | "vencido" | "sin_sctr";

/** Del peor al mejor: el SCTR exige salud Y pensión, así que manda el peor de los dos. */
const PEOR_SCTR: EstadoSctr[] = ["sin_sctr", "vencido", "pendiente_inclusion", "por_iniciar", "activo"];

/**
 * ¿La persona tiene SCTR en esa FECHA (la del servicio)? Misma regla de `vencimientoPersona`
 * evaluada con `fecha` como «hoy», para salud y pensión, y gana el peor. Para Programación.
 *  · póliza o ficha con vencimiento ≥ fecha → activo; < fecha → vencido; sin dato → sin_sctr.
 *  · inclusión solicitada → pendiente_inclusion; confirmada que empieza después → por_iniciar.
 */
export function estadoSctrEn(persona: PersonaFicha, polizas: PolizaRow[], coberturas: CoberturaRow[], fechaServicio: string): EstadoSctr {
  const uno = (t: TipoPersona): EstadoSctr => {
    const v = vencimientoPersona(persona, polizas, coberturas, t, fechaServicio);
    if (v.fuente === "pendiente") return v.inclusion?.estado === "por_iniciar" ? "por_iniciar" : "pendiente_inclusion";
    if (!v.vencimiento) return "sin_sctr";
    return v.vencimiento >= fechaServicio ? "activo" : "vencido";
  };
  const a = uno("sctr_salud"), b = uno("sctr_pension");
  return PEOR_SCTR.indexOf(a) <= PEOR_SCTR.indexOf(b) ? a : b;
}
