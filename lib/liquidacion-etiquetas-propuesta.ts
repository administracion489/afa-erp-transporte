// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-etiquetas-propuesta.ts — El ERP PROPONE lo que es un HECHO; el TURNO
// lo DECIDE el operador. Módulo PURO (sin Supabase, sin React).
//
// Etiquetar a mano un mes entero son cientos de servicios, así que el ERP adelanta lo que
// ya está escrito en otra forma y deja en blanco lo que es una decisión:
//
//   · RUTA   → sale del NOMBRE solo cuando el nombre la dice ("RUTA A/ ENTRADA…"). Si
//              el nombre no trae una letra de ruta, NO se inventa.
//   · TURNO  → NO SE DEDUCE. Es el rango de horas en que trabajan los pasajeros de ese
//              turno, y eso lo sabe el operador, no el orden de salida. Una versión
//              anterior lo numeraba por orden de salida del día y el dueño lo corrigió:
//              un feriado sin el primer bus, un adicional o un cambio de horario movían el
//              número sin que el turno de nadie cambiara. Lo único que se propone es lo
//              que el operador YA escribió: si los días de esa ruta que salen a esa misma
//              hora dicen todos TURNO 1, el día sin etiqueta hereda el 1. Si no hay nada
//              escrito o lo escrito no coincide, el campo queda en blanco y el grupo se
//              ofrece por hora de salida para escribirlo de un golpe.
//   · MÓVIL  → solo cuando 2+ buses de la misma ruta salen A LA MISMA HORA el mismo día
//              (es un hecho, no una decisión). Numerados por PAX contratados (el mayor es
//              el 1) y, a igualdad, por id.
//
// La propuesta NUNCA se escribe sola: solo llena el formulario del modal de etiquetas.
//
// Matriz: npx tsx scripts/prueba-etiquetas.mts
// ──────────────────────────────────────────────────────────────────────────────

import { sentidoDeReserva, sinHoraRuta, type ReservaLiq } from "@/lib/liquidacion-agrupacion";
import { etiquetaCortaDetalle } from "@/lib/ruta-identidad";
import {
  cambiaEtiquetas, compararEtiquetas, etiquetasDelDia, patchEtiquetas, textoDeEtiquetas,
  validarEtiquetas,
  type EtiquetasDelDia, type EtiquetasItem, type TextoEtiquetas, type TramoConEtiquetas,
} from "@/lib/liquidacion-etiquetas";

/** Lo que hace falta de una reserva para proponer y escribir sus etiquetas. */
export type TramoEtq = TramoConEtiquetas & {
  id: number;
  codigo?: string | null;
  cliente_id: number | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  direccion_servicio?: string | null;
  ruta_nombre?: string | null;
  origen?: string | null;
  destino?: string | null;
  reserva_vinculada_id?: number | null;
  estado?: string | null;
  origen_contractual?: string | null;
  capacidad_contratada?: number | null;
};

/** Por qué una propuesta salió incompleta. Se DECLARA: la pantalla enruta por código. */
export type MotivoPropuesta =
  /** Hay RUTA y TURNO propuestos (el turno, heredado de lo que el operador ya escribió). */
  | "propuesta"
  /** El TURNO lo decide el operador: nada escrito a esa hora, o lo escrito no coincide. */
  | "escribe_turno"
  /** El nombre no dice "RUTA X": la RUTA la escribe una persona. */
  | "sin_ruta_en_nombre"
  /** El servicio no tiene hora. */
  | "sin_hora";

export const TEXTO_MOTIVO_PROPUESTA: Record<MotivoPropuesta, string> = {
  propuesta: "turno heredado de los días de esta ruta a la misma hora que ya etiquetaste",
  escribe_turno: "escribe el TURNO (el ERP no lo deduce del horario)",
  sin_ruta_en_nombre: "el nombre del servicio no dice la RUTA: escríbela",
  sin_hora: "el servicio no tiene hora",
};

/** Lo que el ERP propone. Puede venir a medias: lo que falta lo escribe la persona. */
export type PropuestaEtiquetas = { ruta: string | null; turno: number | null; movil: number | null };

/** Un DÍA de servicio: la ida y su retorno (o un tramo suelto). Es lo que se etiqueta. */
export type DiaEtq = {
  /** Estable entre recargas: el menor id del día. */
  clave: string;
  tramos: TramoEtq[];
  ida: TramoEtq | null;
  retorno: TramoEtq | null;
  cliente_id: number | null;
  fecha: string | null;
  horaIda: string | null;
  horaRetorno: string | null;
  /** El nombre de ruta que se lee primero (el de la ida). */
  nombre: string | null;
  /** PAX contratados escritos en el día (la ida primero). Solo para enseñarlos. */
  pax: number | null;
  adicional: boolean;
  /** Lo que ya está escrito. */
  actual: EtiquetasDelDia;
  propuesta: PropuestaEtiquetas;
  motivo: MotivoPropuesta;
  /** Con qué otros días se ordenó el turno: misma ruta del mismo cliente. */
  claveRuta: string;
};

const hhmm = (h?: string | null) => (h ? String(h).slice(0, 5) : null);
const sentido = (t: TramoEtq) => sentidoDeReserva(t as unknown as ReservaLiq);
const esAdicional = (t: TramoEtq | null) => !!t && String(t.origen_contractual || "contrato") !== "contrato";

/** RUTA leída del nombre, y SOLO si el nombre la dice ("RUTA A/ …"). Nunca del recorrido. */
export function rutaDelNombre(nombre: string | null | undefined): string | null {
  const { etiqueta, fuente } = etiquetaCortaDetalle({ ruta_nombre: nombre ?? null });
  return fuente === "nombre" ? etiqueta : null;
}

// ─── Días ────────────────────────────────────────────────────────────────────

/**
 * Arma los DÍAS de un conjunto de tramos: cada tramo con su hermano, buscado por los DOS
 * sentidos del enlace y hacia atrás solo cuando es inequívoco (misma regla que
 * lib/liquidacion-hermanos.ts). Un tramo cuyo hermano no está en el conjunto sale solo.
 */
export function armarDias(tramos: TramoEtq[]): DiaEtq[] {
  const porId = new Map(tramos.map((t) => [t.id, t]));
  const apuntanA = new Map<number, TramoEtq[]>();
  for (const t of tramos) {
    const v = Number(t.reserva_vinculada_id ?? 0);
    if (v) apuntanA.set(v, [...(apuntanA.get(v) ?? []), t]);
  }
  const hermano = (t: TramoEtq): TramoEtq | null => {
    const adelante = t.reserva_vinculada_id ? porId.get(Number(t.reserva_vinculada_id)) : undefined;
    if (adelante && adelante.id !== t.id) return adelante;
    const atras = apuntanA.get(t.id) ?? [];
    return atras.length === 1 && atras[0].id !== t.id ? atras[0] : null;
  };

  const usados = new Set<number>();
  const dias: DiaEtq[] = [];
  // Orden estable: por id, así la misma entrada arma siempre los mismos días.
  for (const t of [...tramos].sort((a, b) => a.id - b.id)) {
    if (usados.has(t.id)) continue;
    usados.add(t.id);
    const h = hermano(t);
    const par = h && !usados.has(h.id) ? h : null;
    if (par) usados.add(par.id);

    let ida: TramoEtq | null = null;
    let retorno: TramoEtq | null = null;
    if (!par) {
      if (sentido(t) === "RETORNO") retorno = t; else ida = t;
    } else if (sentido(t) === sentido(par)) {
      // Dato contradictorio (dos idas enlazadas): se respeta el orden por id.
      ida = t; retorno = par;
    } else if (sentido(t) === "IDA") {
      ida = t; retorno = par;
    } else {
      ida = par; retorno = t;
    }
    const orden = [ida, retorno].filter((x): x is TramoEtq => !!x);
    const pax = orden.map((x) => Number(x.capacidad_contratada ?? 0)).find((n) => Number.isFinite(n) && n > 0) ?? null;
    const nombre = (ida?.ruta_nombre || retorno?.ruta_nombre || "").trim() || null;
    const cliente = (ida ?? retorno)!.cliente_id ?? null;
    const recorrido = [(ida ?? retorno)!.origen, (ida ?? retorno)!.destino].filter(Boolean).join(" → ").toUpperCase();
    const ruta = rutaDelNombre(ida?.ruta_nombre) ?? rutaDelNombre(retorno?.ruta_nombre);
    dias.push({
      clave: `d${Math.min(...orden.map((x) => x.id))}`,
      tramos: orden,
      ida, retorno,
      cliente_id: cliente,
      fecha: (ida ?? retorno)!.fecha_servicio ?? null,
      horaIda: hhmm(ida?.hora_servicio),
      horaRetorno: hhmm(retorno?.hora_servicio),
      nombre,
      pax,
      adicional: esAdicional(ida) || esAdicional(retorno),
      actual: etiquetasDelDia(orden),
      propuesta: { ruta, turno: null, movil: null },
      motivo: "propuesta",
      // La ruta con la que se ordena el turno. La letra si el nombre la trae; si no, el
      // nombre sin la hora; si no, el recorrido. Siempre dentro del mismo cliente.
      claveRuta: `${cliente ?? "x"}|${ruta ?? (nombre ? "N:" + sinHoraRuta(nombre) : "R:" + recorrido)}`,
    });
  }
  return dias;
}

// ─── Propuesta ───────────────────────────────────────────────────────────────

/**
 * Propone RUTA (del nombre), TURNO (solo heredado de lo ya escrito por el operador a la
 * misma hora en la misma ruta, y solo si es unánime) y MÓVIL (buses simultáneos). Recibe
 * TODOS los días del contexto: la herencia y los móviles se miran con los días completos.
 */
export function proponerEtiquetas(dias: DiaEtq[]): DiaEtq[] {
  const porRuta = new Map<string, DiaEtq[]>();
  for (const d of dias) porRuta.set(d.claveRuta, [...(porRuta.get(d.claveRuta) ?? []), d]);

  for (const grupo of porRuta.values()) {
    // Lo que el operador ya escribió, por hora de salida (ida; o retorno si es suelto).
    const escritos = new Map<string, Set<number>>();
    for (const d of grupo) {
      const e = d.actual.etiquetas;
      const h = d.ida ? d.horaIda : d.horaRetorno;
      if (!e || !h) continue;
      const k = `${d.ida ? "I" : "R"}${h}`;
      escritos.set(k, (escritos.get(k) ?? new Set()).add(e.turno));
    }

    // Móviles: 2+ días CONTRATADOS de la misma ruta, la misma fecha y la misma hora.
    const simultaneos = new Map<string, DiaEtq[]>();
    for (const d of grupo) {
      if (!d.ida || d.adicional || !d.fecha || !d.horaIda) continue;
      const k = `${d.fecha}|${d.horaIda}`;
      simultaneos.set(k, [...(simultaneos.get(k) ?? []), d]);
    }
    const movil = new Map<DiaEtq, number>();
    for (const ds of simultaneos.values()) {
      if (ds.length < 2) continue;
      [...ds]
        .sort((a, b) => (b.pax ?? 0) - (a.pax ?? 0) || Number(a.clave.slice(1)) - Number(b.clave.slice(1)))
        .forEach((d, i) => movil.set(d, i + 1));
    }

    for (const d of grupo) {
      const hora = d.ida ? d.horaIda : d.horaRetorno;
      const vistos = hora ? escritos.get(`${d.ida ? "I" : "R"}${hora}`) : undefined;
      const turno = vistos && vistos.size === 1 ? [...vistos][0] : null;
      d.propuesta = { ruta: d.propuesta.ruta, turno, movil: movil.get(d) ?? null };
      d.motivo = !d.propuesta.ruta ? "sin_ruta_en_nombre"
        : !hora ? "sin_hora"
        : !turno ? "escribe_turno"
        : "propuesta";
    }
  }
  return dias;
}

// ─── Grupos para el modal ────────────────────────────────────────────────────

/** Un renglón del modal: días que van a quedar con las MISMAS etiquetas. */
export type GrupoEtq = {
  clave: string;
  cliente_id: number | null;
  /** `actual` = ya estaban escritas · `propuesta` = las sugiere el ERP. */
  fuente: "actual" | "propuesta";
  /** Lo que se precarga en los tres campos. */
  inicial: TextoEtiquetas;
  /** ¿Lo precargado ya es guardable (RUTA y TURNO)? */
  completo: boolean;
  dias: DiaEtq[];
  desde: string | null;
  hasta: string | null;
  /** Horas de salida vistas, con cuántos días: "04:35 ×20 · 05:00 ×6". */
  horas: { hora: string; dias: number }[];
  /** Los nombres de ruta que reúne, el más usado primero. */
  nombres: { nombre: string; dias: number }[];
  /** PAX contratados escritos en esos días (distintos). */
  paxes: number[];
  /** Días cuya ida y retorno tienen etiquetas distintas: se igualan al guardar. */
  conflictos: number;
  /** Días con un solo tramo etiquetado: el otro se completa al guardar. */
  aMedio: number;
  /** Por qué la propuesta vino incompleta, con cuántos días. */
  motivos: { motivo: MotivoPropuesta; dias: number }[];
};

/**
 * Agrupa los días por las etiquetas con las que van a quedar. Lo ya etiquetado se agrupa
 * por lo escrito —salvo `reemplazar`, que pide la propuesta también para ellos—; lo
 * demás, por la propuesta. Dos días sin RUTA propuesta de rutas distintas NO se juntan
 * en un mismo renglón vacío: escribir una RUTA ahí las fundiría.
 */
export function agruparParaEtiquetar(dias: DiaEtq[], opts?: { reemplazar?: boolean }): GrupoEtq[] {
  const grupos = new Map<string, GrupoEtq>();
  for (const d of dias) {
    const usaActual = !!d.actual.etiquetas && !opts?.reemplazar;
    const e = usaActual ? d.actual.etiquetas! : null;
    const p = d.propuesta;
    const ruta = e?.ruta ?? p.ruta;
    const turno = e?.turno ?? p.turno;
    const movil = e ? e.movil : p.movil;
    const clave = [
      d.cliente_id ?? "x",
      usaActual ? "A" : "P",
      ruta ?? `?${d.claveRuta}`,
      // Sin turno, el grupo es la HORA de salida: el operador escribe el turno de todos
      // los días que salen a esa hora de un golpe.
      turno ?? `h:${d.ida ? d.horaIda ?? "-" : "R" + (d.horaRetorno ?? "-")}`,
      movil ?? "-",
    ].join("|");
    let g = grupos.get(clave);
    if (!g) {
      g = {
        clave,
        cliente_id: d.cliente_id,
        fuente: usaActual ? "actual" : "propuesta",
        inicial: usaActual
          ? textoDeEtiquetas(e)
          : { ruta: ruta ?? "", turno: turno ? String(turno) : "", movil: movil ? String(movil) : "" },
        completo: !!ruta && !!turno,
        dias: [], desde: null, hasta: null, horas: [], nombres: [], paxes: [],
        conflictos: 0, aMedio: 0, motivos: [],
      };
      grupos.set(clave, g);
    }
    g.dias.push(d);
  }

  for (const g of grupos.values()) {
    const fechas = g.dias.map((d) => d.fecha).filter((f): f is string => !!f).sort();
    g.desde = fechas[0] ?? null;
    g.hasta = fechas[fechas.length - 1] ?? null;
    const horas = new Map<string, number>();
    const nombres = new Map<string, number>();
    const paxes = new Set<number>();
    const motivos = new Map<MotivoPropuesta, number>();
    for (const d of g.dias) {
      const h = d.horaIda ?? d.horaRetorno;
      if (h) horas.set(h, (horas.get(h) ?? 0) + 1);
      if (d.nombre) nombres.set(d.nombre, (nombres.get(d.nombre) ?? 0) + 1);
      if (d.pax) paxes.add(d.pax);
      if (d.actual.conflicto) g.conflictos++;
      if (d.actual.etiquetas && d.actual.tramosSinEtiqueta > 0) g.aMedio++;
      if (g.fuente === "propuesta" && d.motivo !== "propuesta") motivos.set(d.motivo, (motivos.get(d.motivo) ?? 0) + 1);
    }
    g.horas = [...horas.entries()].map(([hora, dias]) => ({ hora, dias })).sort((a, b) => a.hora.localeCompare(b.hora));
    g.nombres = [...nombres.entries()].map(([nombre, dias]) => ({ nombre, dias })).sort((a, b) => b.dias - a.dias || a.nombre.localeCompare(b.nombre));
    g.paxes = [...paxes].sort((a, b) => a - b);
    g.motivos = [...motivos.entries()].map(([motivo, dias]) => ({ motivo, dias })).sort((a, b) => b.dias - a.dias);
  }

  const aItem = (g: GrupoEtq): EtiquetasItem | null =>
    validarEtiquetas(g.inicial).ok ? (validarEtiquetas(g.inicial) as { etiquetas: EtiquetasItem | null }).etiquetas : null;
  return [...grupos.values()].sort((a, b) =>
    String(a.cliente_id ?? "").localeCompare(String(b.cliente_id ?? ""), "es", { numeric: true })
    || Number(a.completo) - Number(b.completo)          // lo que falta escribir, primero
    || compararEtiquetas(aItem(a), aItem(b))
    || String(a.desde ?? "").localeCompare(String(b.desde ?? "")));
}

// ─── Qué se escribe ──────────────────────────────────────────────────────────

export type DecisionGrupo = TextoEtiquetas & { aplicar: boolean };

export type PlanGuardado = {
  /** Un UPDATE por juego de etiquetas: ids que reciben exactamente ese patch. */
  lotes: { patch: ReturnType<typeof patchEtiquetas>; ids: number[] }[];
  /** Grupos marcados que no se pueden guardar, con el porqué. */
  errores: { clave: string; error: string }[];
  dias: number;
  /** Tramos que cambian. */
  tramos: number;
  /** Tramos que ya decían eso: no se escriben ni se cuentan como actualizados. */
  sinCambio: number;
  /** Tramos a los que se les QUITAN las etiquetas (las tres vacías sobre un grupo etiquetado). */
  quitar: number;
};

/**
 * Lo que se va a escribir, calculado ANTES de escribir: la pantalla enseña este mismo
 * objeto y el botón lo manda. Las etiquetas son del DÍA, así que cada grupo escribe en
 * TODOS los tramos de sus días —la ida y el retorno—, y solo en los que cambian.
 */
export function planDeGuardado(grupos: GrupoEtq[], decisiones: Map<string, DecisionGrupo>): PlanGuardado {
  const plan: PlanGuardado = { lotes: [], errores: [], dias: 0, tramos: 0, sinCambio: 0, quitar: 0 };
  const porPatch = new Map<string, { patch: ReturnType<typeof patchEtiquetas>; ids: number[] }>();
  const escritos = new Set<number>();
  for (const g of grupos) {
    const dec = decisiones.get(g.clave);
    if (!dec?.aplicar) continue;
    const v = validarEtiquetas(dec);
    if (!v.ok) { plan.errores.push({ clave: g.clave, error: v.error }); continue; }
    const patch = patchEtiquetas(v.etiquetas);
    const k = JSON.stringify(patch);
    let lote = porPatch.get(k);
    for (const d of g.dias) {
      plan.dias++;
      for (const t of d.tramos) {
        if (escritos.has(t.id)) continue;             // un tramo, un destino
        escritos.add(t.id);
        if (!cambiaEtiquetas(t, v.etiquetas)) { plan.sinCambio++; continue; }
        if (!lote) { lote = { patch, ids: [] }; porPatch.set(k, lote); }
        lote.ids.push(t.id);
        plan.tramos++;
        if (!v.etiquetas) plan.quitar++;
      }
    }
  }
  plan.lotes = [...porPatch.values()].filter((l) => l.ids.length);
  return plan;
}
