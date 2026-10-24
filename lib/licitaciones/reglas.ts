// lib/licitaciones/reglas.ts — Las 16 reglas verificables del catálogo cerrado. Módulo PURO.
//
// Una regla contesta «¿esta licitación cumple este requisito con los datos del ERP?» con TRES respuestas:
// cumple · no_cumple · no_se_puede_juzgar. La tercera es la que impide los verdes falsos y los rojos
// falsos a la vez:
//  · Una fuente que no se pudo leer (ctx.lecturas[x] !== "ok") NO es una lista vacía: la regla dice
//    «no se puede juzgar» y la revisión nombra UNA vez la fuente caída (D8). Nunca «falta».
//  · Sin año no se afirma la antigüedad, sin capacidad no se afirma el aforo, sin la categoría de la
//    licencia no se afirma que alcance (D9).
//  · Una unidad o un conductor que ya no existe en el ERP no se juzga: tiene su propia alarma
//    (unidad_no_existe) y aquí solo impide afirmar que el conjunto cumple.
//
// `problemas` son los hallazgos ESPECÍFICOS de la regla (llevan el requisito); los genéricos de cada
// recurso (no existe, sin año, sin capacidad) los emite la revisión una sola vez y aquí solo cuentan en
// `codigos` para explicar el resultado.

import { normalizarBusqueda } from "../busqueda-texto";
import { cubreAlguna } from "../licencias-conducir";
import { TIPOS_SEGURO, type FilaSeguro } from "../seguros";
import { estadoLegajo, tipoLegajo } from "./legajo";
import { docDeConductor, docsDeUnidad, resumenUnidad, vigencia } from "./recursos";
import type {
  CodigoHallazgo, ConductorERP, ContextoLicitacion, DondeSeCorrige, Experiencia, FechaISO, FuenteContexto,
  Licitacion, Regla, SujetoHallazgo, TipoRegla, TipoSeguroLic, UnidadElegida, UnidadERP, ConductorElegido,
} from "./tipos";
import { aniosCumplidos, anioDe, fechaDMY, fechaONull, fmtImporte, restarAnios } from "./util";

export type EstadoRegla = "cumple" | "no_cumple" | "no_se_puede_juzgar";
export type ProblemaRegla = { codigo: CodigoHallazgo; sujeto: SujetoHallazgo; texto: string; extra: string; donde?: DondeSeCorrige };
export type ResultadoRegla = {
  estado: EstadoRegla; codigos: CodigoHallazgo[]; detalle: string; sustento: string | null;
  problemas: ProblemaRegla[];
  /** Fuentes que impidieron juzgar (la revisión emite UN fuente_no_leida por cada una). */
  fuentesNoLeidas: FuenteContexto[];
};

export const ETIQUETA_REGLA: Record<TipoRegla, string> = {
  doc_empresa: "Documento de la empresa", unidad_antiguedad_max: "Antigüedad máxima de las unidades",
  unidad_capacidad_min: "Capacidad mínima", unidad_doc: "Documento de cada unidad", unidad_fotos: "Fotos de las unidades",
  unidades_titulares_min: "Unidades titulares", unidades_reten_min: "Unidades de retén",
  conductor_licencia: "Licencia de los conductores", conductor_doc: "Documento de cada conductor",
  conductores_relevo_min: "Conductores de relevo", prohibe_subcontratacion: "Sin subcontratación",
  experiencia_anios_min: "Años de experiencia", experiencia_monto_min: "Monto acreditado de experiencia",
  experiencia_cartas_min: "Cartas de recomendación", experiencia_ventana_anios: "Experiencia reciente",
  seguro: "Póliza de seguro",
};

export const ETIQUETA_SEGURO_LIC: Record<TipoSeguroLic, string> = {
  responsabilidad_civil: "Responsabilidad civil", deshonestidad: "Deshonestidad", todo_riesgo: "Todo riesgo",
  sctr_salud: "SCTR Salud", sctr_pension: "SCTR Pensión", vida_ley: "Vida Ley",
};
const etiquetaSeguro = (s: TipoSeguroLic) => TIPOS_SEGURO[s]?.label ?? ETIQUETA_SEGURO_LIC[s];

const ETIQ_DOC_COND: Record<string, string> = {
  record_conductor: "récord del conductor", antecedentes_penales: "antecedentes penales", antecedentes_policiales: "antecedentes policiales",
  examen_medico: "examen médico", psicosometrico: "examen psicosomático",
};
const ETIQ_DOC_UNIDAD: Record<string, string> = { soat: "SOAT", citv: "revisión técnica", tarjeta_propiedad: "tarjeta de propiedad", tuc: "TUC", habilitacion: "habilitación vehicular" };

/** Qué exige la regla, en una frase (columna «Exigido» y la pantalla). */
export function describirRegla(r: Regla): string {
  switch (r.tipo) {
    case "doc_empresa": return `${tipoLegajo(r.legajo).etiqueta}${r.antiguedadMaxDias ? ` con antigüedad no mayor a ${r.antiguedadMaxDias} días` : ""}`;
    case "unidad_antiguedad_max": return `Unidades con antigüedad máxima de ${r.anios} años`;
    case "unidad_capacidad_min": return `Unidades de ${r.asientos} asientos como mínimo${r.uso ? ` (${r.uso})` : ""}`;
    case "unidad_doc": return `${ETIQ_DOC_UNIDAD[r.doc]} vigente por unidad${r.vigenteAl === "inicio_servicio" ? " al inicio del servicio" : ""}`;
    case "unidad_fotos": return "Fotos de cada unidad, por dentro y por fuera";
    case "unidades_titulares_min": return `${r.n} unidades titulares como mínimo`;
    case "unidades_reten_min": return `${r.n} unidades de retén como mínimo`;
    case "conductor_licencia": return `Licencia vigente de categoría ${r.categorias.join(" o ")}`;
    case "conductor_doc": return `${ETIQ_DOC_COND[r.doc] ?? r.doc} de cada conductor${r.antiguedadMaxDias ? ` (antigüedad no mayor a ${r.antiguedadMaxDias} días)` : ""}`;
    case "conductores_relevo_min": return `${r.n} conductores de relevo como mínimo`;
    case "prohibe_subcontratacion": return "No se permite subcontratar ni consorciarse";
    case "experiencia_anios_min": return `${r.anios} años de experiencia como mínimo${r.desde === "constitucion" ? " desde la constitución" : ""}`;
    case "experiencia_monto_min": return `Experiencia acreditada por ${fmtImporte(r.monto, r.moneda)} como mínimo`;
    case "experiencia_cartas_min": return `Cartas de recomendación de ${r.n} clientes`;
    case "experiencia_ventana_anios": return `Experiencia de los últimos ${r.anios} años`;
    case "seguro": return `Póliza de ${etiquetaSeguro(r.seguro)} vigente${r.vigenteAl === "inicio_servicio" ? " al inicio del servicio" : ""}`;
  }
}

// ══ Ayudas ═════════════════════════════════════════════════════════════════════

const leida = (ctx: ContextoLicitacion, f: FuenteContexto) => ctx.lecturas?.[f] === "ok";
const DONDE_DOCS_UNIDAD = (u: UnidadERP | undefined): DondeSeCorrige =>
  u?.flota === "t" ? { ruta: "/tercerizadas", etiqueta: "Tercerizadas" } : { ruta: "/documentos-vehiculares", etiqueta: "Docs. Vehiculares" };

export const sujetoUnidad = (el: UnidadElegida, u: UnidadERP | undefined): SujetoHallazgo =>
  ({ tipo: "unidad", id: el.clave, rotulo: `${el.codigo || "Unidad"}${u ? ` · ${u.placa}` : ""}` });
export const sujetoConductor = (el: ConductorElegido, c: ConductorERP | undefined): SujetoHallazgo =>
  ({ tipo: "conductor", id: el.clave, rotulo: c?.nombre || "Conductor" });
const sujetoLic = (rotulo: string): SujetoHallazgo => ({ tipo: "licitacion", id: "licitacion", rotulo });
const sujetoExp = (e: Experiencia): SujetoHallazgo => ({ tipo: "experiencia", id: String(e.id), rotulo: e.cliente_nombre });

/** Constructor del resultado: el estado lo decide el conjunto (no_cumple > no_se_puede_juzgar > cumple). */
function armar(opts: { malos: number; dudosos: number; codigos: CodigoHallazgo[]; problemas: ProblemaRegla[]; detalle: string; sustento: string | null; vacio?: string }): ResultadoRegla {
  const estado: EstadoRegla = opts.malos > 0 ? "no_cumple" : opts.dudosos > 0 || opts.vacio ? "no_se_puede_juzgar" : "cumple";
  const codigos = [...new Set([...opts.codigos, ...opts.problemas.map((p) => p.codigo)])];
  return { estado, codigos, detalle: opts.vacio ?? opts.detalle, sustento: opts.sustento, problemas: opts.problemas, fuentesNoLeidas: [] };
}

function sinFuente(...fs: FuenteContexto[]): ResultadoRegla {
  return {
    estado: "no_se_puede_juzgar", codigos: ["fuente_no_leida"],
    detalle: `No se pudo leer ${fs.map((f) => NOMBRE_FUENTE[f]).join(" ni ")} del ERP: no se puede comprobar.`,
    sustento: null, problemas: [], fuentesNoLeidas: fs,
  };
}

export const NOMBRE_FUENTE: Record<FuenteContexto, string> = {
  perfil: "el perfil de la empresa", unidades: "la flota", conductores: "los conductores", legajo: "el legajo de la empresa",
  experiencia: "el catálogo de experiencia", seguros: "las pólizas de seguro", personal: "el personal administrativo",
  otras: "las otras licitaciones",
};

const unidadesDe = (lic: Licitacion, ctx: ContextoLicitacion) => lic.doc.unidades.map((el) => ({ el, u: ctx.unidades?.[el.clave] as UnidadERP | undefined }));
const conductoresDe = (lic: Licitacion, ctx: ContextoLicitacion) => lic.doc.conductores.map((el) => ({ el, c: ctx.conductores?.[el.clave] as ConductorERP | undefined }));
const experienciasDe = (lic: Licitacion, ctx: ContextoLicitacion) =>
  lic.doc.experiencia.ids.map((id) => ctx.experiencia?.[id]).filter((e): e is Experiencia => !!e);

const n = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;

/** Fecha a la que se mide una vigencia: la de inicio si la regla lo pide y existe, si no la de referencia. */
const alRef = (vigenteAl: "presentacion" | "inicio_servicio", ref: FechaISO, inicio: FechaISO | null): FechaISO =>
  vigenteAl === "inicio_servicio" && inicio ? inicio : ref;

/** El documento fijado en el expediente para ese código del legajo (el primero incluido). */
function fijadoEnExpediente(lic: Licitacion, codigo: string): number | null {
  for (const b of lic.doc.expediente.bloques) {
    if (!b.activo) continue;
    for (const i of b.items) if (i.incluido && i.fuente.tipo === "legajo" && i.fuente.codigo === codigo && i.fuente.documentoId != null) return i.fuente.documentoId;
  }
  return null;
}

// ══ Evaluación ═════════════════════════════════════════════════════════════════

/** El resultado completo (con los problemas que la revisión convierte en hallazgos). */
export function evaluarReglaDetallada(regla: Regla, lic: Licitacion, ctx: ContextoLicitacion, ref: FechaISO): ResultadoRegla {
  const inicio = fechaONull(lic.fecha_inicio_servicio);
  switch (regla.tipo) {
    case "doc_empresa": {
      if (!leida(ctx, "legajo")) return sinFuente("legajo");
      const t = tipoLegajo(regla.legajo);
      const r = estadoLegajo(regla.legajo, ctx.legajo ?? [], ref, regla.antiguedadMaxDias, fijadoEnExpediente(lic, regla.legajo));
      const suj: SujetoHallazgo = { tipo: "legajo", id: regla.legajo, rotulo: t.etiqueta };
      const prob = (codigo: CodigoHallazgo, texto: string) => [{ codigo, sujeto: suj, texto, extra: "" }];
      const emitido = r.fila?.fecha_emision ? ` emitida el ${fechaDMY(r.fila.fecha_emision)}` : "";
      const sustento = r.fila ? `${t.etiqueta}${emitido}` : null;
      switch (r.estado) {
        case "falta": return armar({ malos: 1, dudosos: 0, codigos: [], problemas: prob("legajo_falta", `No hay ${t.etiqueta.toLowerCase()} en el legajo de la empresa.`), detalle: "Falta en el legajo.", sustento: null });
        case "vencido": return armar({ malos: 1, dudosos: 0, codigos: [], problemas: prob("legajo_vencido", `${t.etiqueta} venció el ${fechaDMY(r.fila?.fecha_vencimiento)}.`), detalle: "Vencido a la fecha de referencia.", sustento });
        case "sin_archivo": return armar({ malos: 1, dudosos: 0, codigos: [], problemas: prob("legajo_sin_archivo", `${t.etiqueta} está registrado sin archivo.`), detalle: "Registrado sin archivo.", sustento });
        case "antiguo": return armar({ malos: 1, dudosos: 0, codigos: [], problemas: prob("legajo_antiguo", `${t.etiqueta} se emitió hace ${r.edad} días; las bases piden como máximo ${regla.antiguedadMaxDias}.`), detalle: `Emitido hace ${r.edad} días (máximo ${regla.antiguedadMaxDias}).`, sustento });
        case "sin_fecha_emision": return armar({ malos: 0, dudosos: 1, codigos: [], problemas: prob("legajo_sin_fecha_emision", `${t.etiqueta} no tiene fecha de emisión: no se puede comprobar su antigüedad.`), detalle: "Sin fecha de emisión.", sustento });
        default: return armar({ malos: 0, dudosos: 0, codigos: [], problemas: [], detalle: r.estado === "por_vencer" ? `Vigente; vence en ${r.dias} días.` : "Vigente.", sustento });
      }
    }

    case "unidad_antiguedad_max": {
      if (!leida(ctx, "unidades")) return sinFuente("unidades");
      const anioRef = anioDe(alRef(regla.referencia, ref, inicio));
      const us = unidadesDe(lic, ctx);
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let dudosos = 0;
      const anios: number[] = [];
      for (const { el, u } of us) {
        if (!u) { dudosos++; codigos.push("unidad_no_existe"); continue; }
        if (!u.anio) { dudosos++; codigos.push("unidad_sin_anio"); continue; }
        anios.push(u.anio);
        const edad = anioRef - u.anio;
        if (edad > regla.anios) problemas.push({ codigo: "unidad_excede_antiguedad", sujeto: sujetoUnidad(el, u), texto: `${u.placa} es del año ${u.anio}: ${edad} años en ${anioRef}, más que los ${regla.anios} permitidos.`, extra: "" });
      }
      const sustento = anios.length ? `Unidades ${Math.min(...anios)}${Math.max(...anios) !== Math.min(...anios) ? `–${Math.max(...anios)}` : ""}` : null;
      return armar({ malos: problemas.length, dudosos, codigos, problemas, sustento, vacio: us.length ? undefined : "No hay unidades elegidas.",
        detalle: problemas.length ? n(problemas.length, "unidad excede", "unidades exceden") + " la antigüedad." : dudosos ? n(dudosos, "unidad sin año comprobable", "unidades sin año comprobable") + "." : "Todas dentro del límite." });
    }

    case "unidad_capacidad_min": {
      if (!leida(ctx, "unidades")) return sinFuente("unidades");
      const uso = regla.uso ? normalizarBusqueda(regla.uso) : null;
      const us = unidadesDe(lic, ctx).filter(({ el }) => !uso || normalizarBusqueda(el.uso).includes(uso) || (normalizarBusqueda(el.uso) !== "" && uso.includes(normalizarBusqueda(el.uso))));
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let dudosos = 0;
      const caps: number[] = [];
      for (const { el, u } of us) {
        if (!u) { dudosos++; codigos.push("unidad_no_existe"); continue; }
        if (!u.capacidad) { dudosos++; codigos.push("unidad_sin_capacidad"); continue; }
        caps.push(u.capacidad);
        if (u.capacidad < regla.asientos) problemas.push({ codigo: "unidad_capacidad_insuficiente", sujeto: sujetoUnidad(el, u), texto: `${u.placa} tiene ${u.capacidad} asientos; se exigen ${regla.asientos}.`, extra: `min:${regla.asientos}` });
      }
      return armar({ malos: problemas.length, dudosos, codigos, problemas, sustento: caps.length ? `Asientos: ${caps.join(", ")}` : null,
        vacio: us.length ? undefined : regla.uso ? `Ninguna unidad elegida tiene el uso «${regla.uso}».` : "No hay unidades elegidas.",
        detalle: problemas.length ? "Hay unidades con menos asientos." : dudosos ? "Hay unidades sin capacidad comprobable." : "Todas con la capacidad exigida." });
    }

    case "unidad_doc": {
      if (!leida(ctx, "unidades")) return sinFuente("unidades");
      const us = unidadesDe(lic, ctx);
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let malos = 0, dudosos = 0, ok = 0;
      const nombre = ETIQ_DOC_UNIDAD[regla.doc];
      for (const { el, u } of us) {
        if (!u) { dudosos++; codigos.push("unidad_no_existe"); continue; }
        const suj = sujetoUnidad(el, u), donde = DONDE_DOCS_UNIDAD(u);
        const p = docsDeUnidad(u, regla.doc, ref);
        const pi = inicio ? docsDeUnidad(u, regla.doc, inicio) : null;
        if (p.estado === "falta") { malos++; problemas.push({ codigo: "unidad_doc_falta", sujeto: suj, texto: `${u.placa} no tiene ${nombre} registrado.`, extra: regla.doc, donde }); continue; }
        if (p.estado === "vencido") { malos++; problemas.push({ codigo: "unidad_doc_vencido_al_presentar", sujeto: suj, texto: `El ${nombre} de ${u.placa} venció el ${fechaDMY(p.vence)}.`, extra: regla.doc, donde }); }
        else if (pi && pi.estado === "vencido") {
          if (regla.vigenteAl === "inicio_servicio") malos++; else ok++;
          problemas.push({ codigo: "unidad_doc_vence_antes_inicio", sujeto: suj, texto: `El ${nombre} de ${u.placa} vence el ${fechaDMY(p.vence)}, antes del inicio del servicio (${fechaDMY(inicio)}).`, extra: regla.doc, donde });
        } else if (p.estado === "sin_fecha") dudosos++;
        else ok++;
        if (p.fila && p.origen === "vacio") problemas.push({ codigo: "unidad_doc_sin_archivo", sujeto: suj, texto: `El ${nombre} de ${u.placa} está registrado sin PDF.`, extra: regla.doc, donde });
        if (p.fila && p.origen === "externo") problemas.push({ codigo: "unidad_doc_archivo_externo", sujeto: suj, texto: `El ${nombre} de ${u.placa} es un enlace externo (no se puede unir al expediente).`, extra: regla.doc, donde });
      }
      return armar({ malos, dudosos, codigos, problemas, sustento: us.length ? `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} vigente en ${ok} de ${us.length} unidades` : null,
        vacio: us.length ? undefined : "No hay unidades elegidas.",
        detalle: malos ? `${n(malos, "unidad no cumple", "unidades no cumplen")}.` : dudosos ? "Hay documentos sin fecha de vencimiento o unidades que no existen." : "Vigente en todas." });
    }

    case "unidad_fotos": {
      if (!leida(ctx, "unidades")) return sinFuente("unidades");
      const us = unidadesDe(lic, ctx);
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let dudosos = 0, con = 0;
      for (const { el, u } of us) {
        if (!u) { dudosos++; codigos.push("unidad_no_existe"); continue; }
        const r = resumenUnidad(u, { presentacion: ref, inicio: null });
        if (!r.fotos.completas) problemas.push({ codigo: "unidad_sin_fotos", sujeto: sujetoUnidad(el, u), texto: `${u.placa} no tiene ${r.fotos.externa === "vacio" && r.fotos.interna === "vacio" ? "fotos" : r.fotos.externa === "vacio" ? "foto exterior" : "foto interior"}.`, extra: "", donde: u.flota === "t" ? { ruta: "/tercerizadas", etiqueta: "Tercerizadas" } : { ruta: "/vehiculos", etiqueta: "Vehículos" } });
        else con++;
      }
      return armar({ malos: problemas.length, dudosos, codigos, problemas, sustento: con ? `Fotos por dentro y por fuera de ${n(con, "unidad", "unidades")}` : null,
        vacio: us.length ? undefined : "No hay unidades elegidas.", detalle: problemas.length ? "Hay unidades sin fotos." : "Todas con fotos." });
    }

    case "unidades_titulares_min":
    case "unidades_reten_min": {
      if (!leida(ctx, "unidades")) return sinFuente("unidades");
      const rol = regla.tipo === "unidades_titulares_min" ? "titular" : "reten";
      const k = unidadesDe(lic, ctx).filter(({ el, u }) => el.rol === rol && !!u).length;
      const codigo: CodigoHallazgo = rol === "titular" ? "unidades_titulares_insuficientes" : "reten_insuficiente";
      const nombre = rol === "titular" ? ["unidad titular", "unidades titulares"] : ["unidad de retén", "unidades de retén"];
      const problemas = k < regla.n ? [{ codigo, sujeto: sujetoLic("Unidades"), texto: `Hay ${n(k, nombre[0], nombre[1])}; se exigen ${regla.n}.`, extra: "" }] : [];
      return armar({ malos: problemas.length, dudosos: 0, codigos: [], problemas, sustento: k ? n(k, nombre[0], nombre[1]) : null, detalle: `${k} de ${regla.n}.` });
    }

    case "conductor_licencia": {
      if (!leida(ctx, "conductores")) return sinFuente("conductores");
      const cs = conductoresDe(lic, ctx);
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let malos = 0, dudosos = 0;
      const cats = new Map<string, number>();
      for (const { el, c } of cs) {
        if (!c) { dudosos++; codigos.push("conductor_no_existe"); continue; }
        const suj = sujetoConductor(el, c);
        const donde: DondeSeCorrige = c.flota === "t" ? { ruta: "/tercerizadas", etiqueta: "Tercerizadas" } : { ruta: "/conductores", etiqueta: "Conductores" };
        if (!c.licencia?.trim() && !c.categoria_licencia?.trim()) { malos++; problemas.push({ codigo: "conductor_sin_licencia", sujeto: suj, texto: `${c.nombre} no tiene licencia registrada.`, extra: "", donde }); continue; }
        const cubre = cubreAlguna(c.categoria_licencia, regla.categorias);
        if (cubre === null) { dudosos++; }
        else if (!cubre) { malos++; problemas.push({ codigo: "conductor_categoria_insuficiente", sujeto: suj, texto: `${c.nombre} tiene licencia ${c.categoria_licencia}; se exige ${regla.categorias.join(" o ")}.`, extra: regla.categorias.join(","), donde }); }
        else cats.set(c.categoria_licencia!.trim(), (cats.get(c.categoria_licencia!.trim()) ?? 0) + 1);
        const venc = fechaONull(c.vencimiento_licencia);
        if (!venc) { if (cubre) dudosos++; continue; }
        if (vigencia(venc, ref).estado === "vencido") { malos++; problemas.push({ codigo: "conductor_licencia_vencida", sujeto: suj, texto: `La licencia de ${c.nombre} venció el ${fechaDMY(venc)}.`, extra: "", donde }); }
        else if (inicio && vigencia(venc, inicio).estado === "vencido") problemas.push({ codigo: "conductor_licencia_vence_antes_inicio", sujeto: suj, texto: `La licencia de ${c.nombre} vence el ${fechaDMY(venc)}, antes del inicio del servicio.`, extra: "", donde });
      }
      return armar({ malos, dudosos, codigos, problemas, sustento: cats.size ? `Licencias ${[...cats].map(([k, v]) => `${k} (${v})`).join(", ")}` : null,
        vacio: cs.length ? undefined : "No hay conductores elegidos.",
        detalle: malos ? `${n(malos, "conductor no cumple", "conductores no cumplen")}.` : dudosos ? "Hay licencias sin categoría reconocible o sin vencimiento." : "Todas las licencias alcanzan." });
    }

    case "conductor_doc": {
      if (!leida(ctx, "conductores")) return sinFuente("conductores");
      const cs = conductoresDe(lic, ctx);
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let malos = 0, dudosos = 0, ok = 0;
      const nombre = ETIQ_DOC_COND[regla.doc] ?? regla.doc;
      for (const { el, c } of cs) {
        if (!c) { dudosos++; codigos.push("conductor_no_existe"); continue; }
        const suj = sujetoConductor(el, c);
        const d = docDeConductor(c, regla.doc, { presentacion: ref, inicio });
        const dondeDoc: DondeSeCorrige = { ruta: "/documentos", etiqueta: "Documentos" };
        if (!d.fila) {
          if (d.columna !== "con_fecha") {
            // Un tercero no tiene dónde registrar el documento hasta la migración 04 (conductor_tercero_id):
            // ahí no se juzga, porque su ausencia no prueba nada.
            dudosos++;
            if (c.flota === "t" && ctx.migraciones?.conductorTercero === false) continue;
            problemas.push({ codigo: "conductor_doc_no_registrado", sujeto: suj, texto: `${c.nombre} no tiene ${nombre} registrado.`, extra: regla.doc, donde: dondeDoc });
            continue;
          }
          problemas.push({ codigo: "conductor_doc_sin_archivo", sujeto: suj, texto: `${c.nombre} tiene la fecha del ${nombre} en su ficha pero no el archivo.`, extra: regla.doc, donde: dondeDoc });
        } else if (d.origen === "vacio" || d.origen === "externo") {
          problemas.push({ codigo: "conductor_doc_sin_archivo", sujeto: suj, texto: `El ${nombre} de ${c.nombre} ${d.origen === "externo" ? "es un enlace externo" : "está registrado sin archivo"}.`, extra: regla.doc, donde: dondeDoc });
        }
        if (d.fechasDistintas) problemas.push({ codigo: "conductor_doc_fechas_distintas", sujeto: suj, texto: `La ficha de ${c.nombre} dice que el ${nombre} vence el ${fechaDMY(d.venc)} y el archivo dice ${fechaDMY(d.fila?.fecha_vencimiento)}.`, extra: regla.doc, donde: { ruta: "/conductores", etiqueta: "Conductores" } });
        if (d.presentacion.estado === "vencido") { malos++; problemas.push({ codigo: "conductor_doc_vencido", sujeto: suj, texto: `El ${nombre} de ${c.nombre} venció el ${fechaDMY(d.venc)}.`, extra: regla.doc }); continue; }
        if (regla.antiguedadMaxDias) {
          if (d.edad === null) { dudosos++; continue; }
          if (d.edad > regla.antiguedadMaxDias) { malos++; problemas.push({ codigo: "conductor_doc_vencido", sujeto: suj, texto: `El ${nombre} de ${c.nombre} se emitió hace ${d.edad} días; las bases piden como máximo ${regla.antiguedadMaxDias}.`, extra: `${regla.doc}:antiguo` }); continue; }
        } else if (d.presentacion.estado === "sin_fecha") { dudosos++; continue; }
        ok++;
      }
      return armar({ malos, dudosos, codigos, problemas, sustento: cs.length ? `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} de ${ok} de ${cs.length} conductores` : null,
        vacio: cs.length ? undefined : "No hay conductores elegidos.",
        detalle: malos ? `${n(malos, "conductor no cumple", "conductores no cumplen")}.` : dudosos ? "Hay conductores cuyo documento no se puede comprobar." : "Vigente en todos." });
    }

    case "conductores_relevo_min": {
      if (!leida(ctx, "conductores")) return sinFuente("conductores");
      const k = conductoresDe(lic, ctx).filter(({ el, c }) => el.rol === "relevo" && !!c).length;
      const problemas = k < regla.n ? [{ codigo: "conductores_relevo_insuficientes" as CodigoHallazgo, sujeto: sujetoLic("Conductores"), texto: `Hay ${n(k, "conductor de relevo", "conductores de relevo")}; se exigen ${regla.n}.`, extra: "" }] : [];
      return armar({ malos: problemas.length, dudosos: 0, codigos: [], problemas, sustento: k ? n(k, "conductor de relevo", "conductores de relevo") : null, detalle: `${k} de ${regla.n}.` });
    }

    case "prohibe_subcontratacion": {
      const faltan: FuenteContexto[] = [];
      if (!leida(ctx, "unidades")) faltan.push("unidades");
      if (!leida(ctx, "conductores")) faltan.push("conductores");
      if (faltan.length) return sinFuente(...faltan);
      const problemas: ProblemaRegla[] = [], codigos: CodigoHallazgo[] = [];
      let dudosos = 0;
      for (const { el, u } of unidadesDe(lic, ctx)) {
        if (!u) { dudosos++; codigos.push("unidad_no_existe"); continue; }
        if (u.flota === "t") problemas.push({ codigo: "unidad_tercerizada_prohibida", sujeto: sujetoUnidad(el, u), texto: `${u.placa} es de ${u.empresa?.razon_social ?? "una empresa tercerizada"}, y las bases no permiten subcontratar.`, extra: "" });
      }
      for (const { el, c } of conductoresDe(lic, ctx)) {
        if (!c) { dudosos++; codigos.push("conductor_no_existe"); continue; }
        if (c.flota === "t") problemas.push({ codigo: "conductor_tercerizado_prohibido", sujeto: sujetoConductor(el, c), texto: `${c.nombre} es conductor de ${c.empresa?.razon_social ?? "una empresa tercerizada"}, y las bases no permiten subcontratar.`, extra: "" });
      }
      return armar({ malos: problemas.length, dudosos, codigos, problemas, sustento: problemas.length ? null : "Sin unidades ni conductores tercerizados",
        detalle: problemas.length ? `${n(problemas.length, "recurso tercerizado", "recursos tercerizados")} en un concurso que no permite subcontratar.` : "Ninguna unidad ni conductor tercerizado." });
    }

    case "experiencia_anios_min": {
      if (!leida(ctx, "experiencia")) return sinFuente("experiencia");
      let desde: FechaISO | null = null;
      if (regla.desde === "constitucion") {
        if (!leida(ctx, "perfil")) return sinFuente("perfil");
        desde = fechaONull(ctx.perfil?.fecha_constitucion);
        if (!desde) return armar({ malos: 0, dudosos: 1, codigos: [], problemas: [{ codigo: "experiencia_sin_fecha_constitucion", sujeto: sujetoLic("Perfil de la empresa"), texto: ctx.migraciones?.fechaConstitucion === false ? "El perfil todavía no guarda la fecha de constitución (falta la migración licitaciones-04)." : "El perfil de la empresa no tiene la fecha de constitución.", extra: "" }], detalle: "Sin fecha de constitución.", sustento: null });
      } else {
        desde = experienciasDe(lic, ctx).map((e) => fechaONull(e.inicio)).filter((f): f is string => !!f).sort()[0] ?? null;
        if (!desde) return armar({ malos: 0, dudosos: 1, codigos: [], problemas: [], detalle: "No hay experiencia elegida con fecha de inicio.", sustento: null });
      }
      const anios = aniosCumplidos(desde, ref);
      const problemas = anios < regla.anios ? [{ codigo: "experiencia_anios_insuficientes" as CodigoHallazgo, sujeto: sujetoLic("Experiencia"), texto: `Se acreditan ${anios} años (desde el ${fechaDMY(desde)}); se exigen ${regla.anios}.`, extra: "" }] : [];
      return armar({ malos: problemas.length, dudosos: 0, codigos: [], problemas, sustento: `${n(Math.max(anios, 0), "año", "años")} (desde ${fechaDMY(desde)})`, detalle: `${anios} de ${regla.anios} años.` });
    }

    case "experiencia_monto_min": {
      if (!leida(ctx, "experiencia")) return sinFuente("experiencia");
      const es = experienciasDe(lic, ctx);
      if (!es.length) return armar({ malos: 0, dudosos: 0, codigos: [], problemas: [], detalle: "", sustento: null, vacio: "No hay experiencia elegida." });
      const problemas: ProblemaRegla[] = [];
      let total = 0, sinImporte = 0, otra = 0;
      for (const e of es) {
        if (e.importe == null) { sinImporte++; problemas.push({ codigo: "experiencia_sin_importe", sujeto: sujetoExp(e), texto: `${e.cliente_nombre} no tiene importe registrado.`, extra: "" }); continue; }
        if ((e.moneda === "USD" ? "USD" : "PEN") !== regla.moneda) { otra++; continue; }
        total += e.importe;
      }
      // Los importes en otra moneda NO se suman ni se convierten: sin ellos no se puede afirmar que falte.
      if (otra) problemas.push({ codigo: "experiencia_moneda_mixta", sujeto: sujetoLic("Experiencia"), texto: `${n(otra, "contrato está", "contratos están")} en otra moneda; el ERP no convierte monedas.`, extra: regla.moneda });
      const sustento = `${fmtImporte(total, regla.moneda)} acreditados`;
      if (total >= regla.monto) return armar({ malos: 0, dudosos: 0, codigos: [], problemas, sustento, detalle: "Monto alcanzado." });
      if (sinImporte || otra) return armar({ malos: 0, dudosos: 1, codigos: [], problemas, sustento, detalle: "Hay contratos sin importe o en otra moneda: no se puede afirmar que el monto no alcance." });
      problemas.push({ codigo: "experiencia_monto_insuficiente", sujeto: sujetoLic("Experiencia"), texto: `Se acreditan ${fmtImporte(total, regla.moneda)}; se exigen ${fmtImporte(regla.monto, regla.moneda)}.`, extra: "" });
      return armar({ malos: 1, dudosos: 0, codigos: [], problemas, sustento, detalle: "Monto insuficiente." });
    }

    case "experiencia_cartas_min": {
      if (!leida(ctx, "experiencia")) return sinFuente("experiencia");
      const cartas = experienciasDe(lic, ctx).filter((e) => e.sustento_tipo === "carta");
      const problemas: ProblemaRegla[] = [];
      for (const e of cartas) if (!e.sustentos?.length) problemas.push({ codigo: "experiencia_sin_sustento", sujeto: sujetoExp(e), texto: `La carta de ${e.cliente_nombre} no tiene archivo.`, extra: "" });
      const clientes = new Set(cartas.map((e) => (e.cliente_id != null ? `id:${e.cliente_id}` : normalizarBusqueda(e.cliente_nombre))));
      const k = clientes.size;
      if (k < regla.n) problemas.push({ codigo: "experiencia_cartas_insuficientes", sujeto: sujetoLic("Experiencia"), texto: `Hay cartas de ${n(k, "cliente", "clientes")}; se exigen ${regla.n}.`, extra: "" });
      return armar({ malos: k < regla.n ? 1 : 0, dudosos: 0, codigos: [], problemas, sustento: k ? `Cartas de recomendación de ${n(k, "cliente", "clientes")}` : null, detalle: `${k} de ${regla.n}.` });
    }

    case "experiencia_ventana_anios": {
      if (!leida(ctx, "experiencia")) return sinFuente("experiencia");
      const es = experienciasDe(lic, ctx);
      const limite = restarAnios(ref, regla.anios);
      const problemas: ProblemaRegla[] = [];
      let dentro = 0;
      for (const e of es) {
        const fin = e.vigente ? ref : fechaONull(e.fin) ?? fechaONull(e.inicio);
        if (fin && fin >= limite) { dentro++; continue; }
        problemas.push({ codigo: "experiencia_fuera_de_ventana", sujeto: sujetoExp(e), texto: `${e.cliente_nombre} terminó el ${fechaDMY(fin)}, antes de la ventana de ${regla.anios} años (desde el ${fechaDMY(limite)}).`, extra: "" });
      }
      return armar({ malos: es.length && !dentro ? 1 : 0, dudosos: 0, codigos: [], problemas, sustento: dentro ? `${n(dentro, "contrato", "contratos")} de los últimos ${regla.anios} años` : null,
        vacio: es.length ? undefined : "No hay experiencia elegida.", detalle: `${dentro} de ${es.length} dentro de la ventana.` });
    }

    case "seguro": {
      if (!leida(ctx, "seguros")) return sinFuente("seguros");
      const nombre = etiquetaSeguro(regla.seguro);
      const suj: SujetoHallazgo = { tipo: "seguro", id: regla.seguro, rotulo: nombre };
      const fila = mejorSeguro(ctx.seguros ?? [], regla.seguro);
      if (!fila) return armar({ malos: 1, dudosos: 0, codigos: [], problemas: [{ codigo: "seguro_falta", sujeto: suj, texto: `No hay póliza de ${nombre} registrada.`, extra: "" }], detalle: "No registrada.", sustento: null });
      const problemas: ProblemaRegla[] = [];
      const venc = fechaONull(fila.vencimiento);
      const p = vigencia(venc, ref), pi = inicio ? vigencia(venc, inicio) : null;
      let malos = 0, dudosos = 0;
      if (p.estado === "vencido") { malos++; problemas.push({ codigo: "seguro_vencido", sujeto: suj, texto: `La póliza de ${nombre} venció el ${fechaDMY(venc)}.`, extra: "" }); }
      else if (pi?.estado === "vencido") {
        if (regla.vigenteAl === "inicio_servicio") malos++;
        problemas.push({ codigo: "seguro_vence_antes_inicio", sujeto: suj, texto: `La póliza de ${nombre} vence el ${fechaDMY(venc)}, antes del inicio del servicio.`, extra: "" });
      } else if (p.estado === "sin_fecha") dudosos++;
      if (!fila.archivo) problemas.push({ codigo: "seguro_sin_archivo", sujeto: suj, texto: `La póliza de ${nombre} está registrada sin archivo.`, extra: "", donde: { ruta: fila.editarEn || "/seguros", etiqueta: "Seguros" } });
      return armar({ malos, dudosos, codigos: [], problemas, sustento: `Póliza ${nombre}${fila.aseguradora ? ` (${fila.aseguradora})` : ""}${venc ? ` vigente hasta ${fechaDMY(venc)}` : ""}`,
        detalle: malos ? "No vigente a la fecha exigida." : dudosos ? "Póliza sin fecha de vencimiento." : "Vigente." });
    }
  }
}

/** La póliza que vale para ese tipo: de AFA primero, la de vencimiento más lejano. */
export function mejorSeguro(filas: readonly FilaSeguro[], tipo: TipoSeguroLic): FilaSeguro | null {
  const cands = (filas || []).filter((f) => !!f && (f.tipos?.length ? f.tipos : [f.tipo]).includes(tipo));
  const propias = cands.filter((f) => f.deAfa);
  const pool = propias.length ? propias : cands;
  if (!pool.length) return null;
  return pool.reduce((a, b) => {
    const va = fechaONull(a.vencimiento), vb = fechaONull(b.vencimiento);
    if (!va) return vb ? b : (a.archivo || !b.archivo ? a : b);
    if (!vb) return a;
    if (vb !== va) return vb > va ? b : a;
    return a.archivo || !b.archivo ? a : b;
  });
}

/** La forma pública: estado, códigos, detalle y sustento. */
export function evaluarRegla(regla: Regla, lic: Licitacion, ctx: ContextoLicitacion, ref: FechaISO): { estado: EstadoRegla; codigos: CodigoHallazgo[]; detalle: string; sustento: string | null } {
  const r = evaluarReglaDetallada(regla, lic, ctx, ref);
  return { estado: r.estado, codigos: r.codigos, detalle: r.detalle, sustento: r.sustento };
}
