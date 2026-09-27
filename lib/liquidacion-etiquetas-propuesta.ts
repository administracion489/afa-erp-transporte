// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-etiquetas-propuesta.ts — El ERP PROPONE las etiquetas por horario;
// las confirma una persona. Módulo PURO (sin Supabase, sin React).
//
// Etiquetar a mano un mes entero son cientos de servicios. Pero casi todo lo que hace
// falta ya está escrito en otra forma, y lo que no está, se nombra:
//
//   · RUTA   → sale del NOMBRE solo cuando el nombre la dice ("RUTA A/ ENTRADA…"). Si
//              el nombre no trae una letra de ruta, NO se inventa: el grupo sale con la
//              RUTA en blanco y la escribe la persona.
//   · TURNO  → el orden de salida de la ruta ESE DÍA: la más temprana es el TURNO 1, la
//              siguiente el 2. Es la definición del dueño («T1 temprano, T2 siguiente») y
//              es la que hace que un cambio de horario NO cambie el turno: si la RUTA A
//              sale a las 04:35 una semana y a las 05:00 la siguiente, las dos son su
//              primera salida del día.
//   · MÓVIL  → solo cuando 2+ buses de la misma ruta salen A LA MISMA HORA el mismo día.
//              Numerados por PAX contratados (el mayor es el 1, como en los formatos que
//              AFA ya emite) y, a igualdad, por id — el generador inserta cada móvil del
//              contrato en su propio lote, así que el id mantiene el mismo número todos
//              los días.
//
// CUANDO EL DÍA NO SE PARECE A LOS DEMÁS, NO SE ADIVINA
//
// Contar salidas funciona mientras cada día salgan las mismas. Un feriado en que solo sale
// el segundo turno tiene UNA salida, y contarla la haría "TURNO 1". Por eso el turno se
// cuenta directo solo en los días que tienen el número de salidas habitual de la ruta (la
// moda); en los demás, cada salida se compara contra la hora típica de cada turno, y se
// propone solo si la más cercana es ÚNICA, está a menos de `TOLERANCIA_TURNO_MIN` y el día
// entero queda en orden. Si no, el día sale sin turno propuesto y con su motivo.
//
// El orden de los controles es el de siempre: de la evidencia al juicio. Y la propuesta
// NUNCA se escribe sola: solo llena el formulario del modal de etiquetas.
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

/**
 * Cuánto puede separarse una salida de la hora típica de su turno para proponérselo en un
 * día atípico. NO está medido: es el colchón contra el corrimiento normal de un horario. El
 * lado seguro es BAJARLO — deja más días sin propuesta, que se etiquetan a mano; subirlo
 * propone turnos a salidas que no se parecen a ninguno.
 */
export const TOLERANCIA_TURNO_MIN = 120;

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
  /** Hay RUTA y TURNO propuestos. */
  | "propuesta"
  /** El nombre no dice "RUTA X": la RUTA la escribe una persona. */
  | "sin_ruta_en_nombre"
  /** Ese día salieron más o menos buses que lo habitual y la hora no decide el turno. */
  | "turno_ambiguo"
  /** El servicio no tiene hora: no hay con qué ordenarlo. */
  | "sin_hora";

export const TEXTO_MOTIVO_PROPUESTA: Record<MotivoPropuesta, string> = {
  propuesta: "propuesta por horario",
  sin_ruta_en_nombre: "el nombre del servicio no dice la RUTA: escríbela",
  turno_ambiguo: "ese día no salieron las mismas unidades que los demás y la hora no decide el turno: escríbelo",
  sin_hora: "el servicio no tiene hora: escribe el turno",
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
const aMin = (h: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
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

// ─── Turnos por horario ──────────────────────────────────────────────────────

const mediana = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * El turno más cercano a una hora, y solo si es INEQUÍVOCO: la distancia al más cercano
 * tiene que ser estrictamente menor que al segundo, y no pasar de la tolerancia.
 */
function turnoMasCercano(min: number, tipicas: number[]): number | null {
  const d = tipicas.map((t, i) => ({ i, d: Math.abs(t - min) })).sort((a, b) => a.d - b.d);
  if (!d.length) return null;
  if (d.length > 1 && d[0].d === d[1].d) return null;
  if (d[0].d > TOLERANCIA_TURNO_MIN) return null;
  return d[0].i + 1;
}

/**
 * Asigna el turno a cada día de una ruta según su hora de salida.
 *
 * `base` define la estructura (cuántas salidas tiene un día normal y a qué hora sale cada
 * turno); `aAsignar` recibe el turno. Normalmente son los mismos días; los adicionales y
 * los retornos sueltos se asignan contra la estructura de los demás, nunca la definen.
 */
function turnosPorHorario(
  base: DiaEtq[],
  aAsignar: DiaEtq[],
  horaDe: (d: DiaEtq) => number | null,
): { turno: Map<DiaEtq, number | null>; tipicas: number[] } {
  const turno = new Map<DiaEtq, number | null>();
  const baseSet = new Set(base);

  // Salidas DISTINTAS por fecha: dos buses a la misma hora son un solo turno (dos móviles).
  const porFecha = new Map<string, number[]>();
  for (const d of base) {
    const h = horaDe(d);
    if (h == null || !d.fecha) continue;
    const ya = porFecha.get(d.fecha) ?? [];
    if (!ya.includes(h)) ya.push(h);
    porFecha.set(d.fecha, ya);
  }
  for (const hs of porFecha.values()) hs.sort((a, b) => a - b);
  if (!porFecha.size) {
    for (const d of aAsignar) turno.set(d, null);
    return { turno, tipicas: [] };
  }

  // Cuántas salidas tiene un día NORMAL: la moda. En empate, la mayor, para que los días
  // completos se cuenten directo y los que tienen menos se comparen por la hora típica.
  const frec = new Map<number, number>();
  for (const hs of porFecha.values()) frec.set(hs.length, (frec.get(hs.length) ?? 0) + 1);
  const K = [...frec.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const completas = [...porFecha.values()].filter((hs) => hs.length === K);
  const tipicas = Array.from({ length: K }, (_, k) => mediana(completas.map((hs) => hs[k])));

  // Un día atípico se asigna ENTERO o nada: cada salida a su turno más cercano, sin repetir
  // y en orden. Si dos salidas caen en el mismo turno, o el orden se invierte, no se adivina.
  const planFecha = new Map<string, Map<number, number> | null>();
  const planDe = (fecha: string, hs: number[]): Map<number, number> | null => {
    if (planFecha.has(fecha)) return planFecha.get(fecha)!;
    let plan: Map<number, number> | null = new Map();
    if (hs.length === K) hs.forEach((h, i) => plan!.set(h, i + 1));
    else {
      let previo = 0;
      for (const h of hs) {
        const k = turnoMasCercano(h, tipicas);
        if (k == null || k <= previo) { plan = null; break; }
        plan.set(h, k);
        previo = k;
      }
    }
    planFecha.set(fecha, plan);
    return plan;
  };

  for (const d of aAsignar) {
    const h = horaDe(d);
    if (h == null) { turno.set(d, null); continue; }
    if (baseSet.has(d) && d.fecha && porFecha.has(d.fecha)) {
      turno.set(d, planDe(d.fecha, porFecha.get(d.fecha)!)?.get(h) ?? null);
      continue;
    }
    turno.set(d, turnoMasCercano(h, tipicas));
  }
  return { turno, tipicas };
}

/**
 * Propone RUTA, TURNO y MÓVIL para cada día. Recibe TODOS los días del contexto (el turno
 * es el orden de salida del día, así que se cuenta con los días completos, no solo con los
 * que se van a etiquetar) y devuelve los mismos días con `propuesta` y `motivo` puestos.
 */
export function proponerEtiquetas(dias: DiaEtq[]): DiaEtq[] {
  const porRuta = new Map<string, DiaEtq[]>();
  for (const d of dias) porRuta.set(d.claveRuta, [...(porRuta.get(d.claveRuta) ?? []), d]);

  for (const grupo of porRuta.values()) {
    const conIda = grupo.filter((d) => d.ida);
    const soloRetorno = grupo.filter((d) => !d.ida);

    // La estructura la define lo CONTRATADO: un adicional a las 12:00 no es un tercer
    // turno de la ruta. Si la ruta solo tiene adicionales, se ordenan entre ellos.
    const baseIda = conIda.filter((d) => !d.adicional);
    const { turno: tIda } = turnosPorHorario(
      baseIda.length ? baseIda : conIda, conIda, (d) => aMin(d.horaIda));

    // Retornos sueltos (la ida se borró): contra la hora típica de RETORNO de cada turno,
    // medida en los días que sí tienen los dos tramos. Sin esos días, entre ellos.
    const tRet = new Map<DiaEtq, number | null>();
    if (soloRetorno.length) {
      const porTurno = new Map<number, number[]>();
      for (const d of conIda) {
        const k = tIda.get(d);
        const m = aMin(d.horaRetorno);
        if (k && m != null && !d.adicional) porTurno.set(k, [...(porTurno.get(k) ?? []), m]);
      }
      if (porTurno.size) {
        const max = Math.max(...porTurno.keys());
        // Un turno sin retornos medidos queda con una típica imposible, para que nunca sea
        // el "más cercano" de nadie.
        const tipicas = Array.from({ length: max }, (_, i) =>
          porTurno.has(i + 1) ? mediana(porTurno.get(i + 1)!) : Number.MAX_SAFE_INTEGER / 4);
        for (const d of soloRetorno) {
          const m = aMin(d.horaRetorno);
          tRet.set(d, m == null ? null : turnoMasCercano(m, tipicas));
        }
      } else {
        const baseRet = soloRetorno.filter((d) => !d.adicional);
        const { turno } = turnosPorHorario(
          baseRet.length ? baseRet : soloRetorno, soloRetorno, (d) => aMin(d.horaRetorno));
        for (const [d, k] of turno) tRet.set(d, k);
      }
    }

    // Móviles: 2+ días CONTRATADOS de la misma ruta, la misma fecha y la misma hora de
    // salida. El mayor PAX contratado es el 1; a igualdad, el id.
    const simultaneos = new Map<string, DiaEtq[]>();
    for (const d of conIda) {
      if (d.adicional || !d.fecha || !d.horaIda) continue;
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
      const turno = d.ida ? tIda.get(d) ?? null : tRet.get(d) ?? null;
      d.propuesta = { ruta: d.propuesta.ruta, turno, movil: movil.get(d) ?? null };
      d.motivo = !hora ? "sin_hora"
        : !turno ? "turno_ambiguo"
        : !d.propuesta.ruta ? "sin_ruta_en_nombre"
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
      turno ?? `?${d.motivo}`,
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
