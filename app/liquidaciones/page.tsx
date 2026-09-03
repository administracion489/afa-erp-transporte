"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /liquidaciones — Cierre de periodo entre Operaciones y Finanzas.
//
//   Pestaña CLIENTE:   servicios finalizados "por liquidar" → valorización por
//                      cliente + sede → PDF AFA-FL-07 → conformidad → factura.
//   Pestaña PROVEEDOR: servicios tercerizados "por conciliar" → AFA-FL-08 →
//                      cuenta por pagar.
//
// La idea central: no se liquida servicio por servicio, se CIERRA UN PERIODO. Se
// eligen los grupos y un botón genera todas las liquidaciones del mes de una pasada.
// Antes de dejar liquidar, la pantalla muestra en rojo lo que está mal (sin precio,
// sin unidad, no finalizado): una valorización mal armada se descubre cuando el
// cliente la rechaza, semanas después.
//
// Requiere haber corrido supabase/liquidaciones-v2.sql.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import {
  agruparServicios, analizarServicios, etiquetaRuta,
  type ReservaLiq, type CatalogoLiq, type LineaAgrupada, type LadoLiquidacion,
  type ParServicio, type ReservaBloqueada,
} from "@/lib/liquidacion-agrupacion";
import { indiceHermanos, type EnlacePendiente } from "@/lib/liquidacion-hermanos";
import {
  cargarRutasContratadas, cargarPaxDeCotizaciones, resolverPaxContratado,
  type CatalogoRutas,
} from "@/lib/liquidacion-rutas";
import ModalRutasContratadas, { type RutaDelPeriodo } from "./ModalRutasContratadas";
import ModalPrecios, { type ReservaSinPrecio } from "./ModalPrecios";
import ModalEnlaces from "./ModalEnlaces";
import ModalServicios from "./ModalServicios";
import {
  crearLiquidaciones, igvVigente, aprobarLiquidacionCliente, aprobarLiquidacionProveedor,
  anularLiquidacion, liberarServicios, volverABorrador, hoyLima,
} from "@/lib/liquidaciones";
import { cargarDocumentoLiquidacion } from "@/lib/liquidacion-datos";
import { buildLiquidacionHtml } from "@/lib/liquidacion-doc";
import ModalEditor from "./ModalEditor";
import ModalSede, { SEDE_VACIA, type Sede } from "./ModalSede";
import ModalEnviar from "./ModalEnviar";
import ModalCostos, { type ReservaSinCosto } from "@/components/pactos/ModalCostos";

const COLS_RESERVA =
  "id,codigo,fecha_servicio,hora_servicio,estado,estado_admin,estado_proveedor,cliente_id,cliente_sede_id," +
  "ruta_nombre,direccion_servicio,origen,destino,precio_cliente,costo_proveedor,tipo_asignacion," +
  "vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,empresa_tercerizada_id," +
  "pasajeros_abordados,hora_real_inicio,hora_real_fin,tipo_servicio_detalle,cotizacion_id," +
  "reserva_vinculada_id,liquidacion_cliente_id,liquidacion_proveedor_id";

/** La añade supabase/liquidaciones-03: se pide aparte para no tumbar la pantalla si falta. */
const COL_PAX_CONTRATADO = "capacidad_contratada";

/** La añade supabase/reservas-04 (servicios adicionales). Misma prudencia. */
const COL_ORIGEN = "origen_contractual";

/**
 * Los paraderos del tramo. Es el eje del MAPA de la agrupación: sin esto, dos redacciones
 * distintas del mismo recorrido ("BSF→1RO DE MAYO" y "BSF→ALIPIO") vuelven a salir como
 * dos ítems. Se pide junto a las demás opcionales y con la misma cascada: si la columna no
 * estuviera, la agrupación se apoya solo en el nombre, que es como se comportaba antes.
 */
const COL_PARADAS = "paradas_json";

/** Paginación defensiva: PostgREST corta en 1000 filas y un mes de operación pasa de eso. */
async function traerTodo(query: () => any): Promise<any[]> {
  const paso = 1000; let desde = 0; const acc: any[] = [];
  for (;;) {
    const { data, error } = await query().range(desde, desde + paso - 1);
    if (error) throw new Error(error.message);
    const filas = (data as any[]) ?? [];
    acc.push(...filas);
    if (filas.length < paso) break;
    desde += paso;
  }
  return acc;
}

// ── Periodo ─────────────────────────────────────────────────────────────────

function mesAnterior(): { desde: string; hasta: string } {
  const hoy = new Date(hoyLima() + "T12:00:00");
  const primero = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const ultimo = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { desde: f(primero), hasta: f(ultimo) };
}

/** Quincena "del 15 al 14", que es como cierran varios clientes corporativos de AFA. */
function quincena15(): { desde: string; hasta: string } {
  const hoy = new Date(hoyLima() + "T12:00:00");
  const finMes = hoy.getDate() > 14 ? hoy.getMonth() : hoy.getMonth() - 1;
  const desde = new Date(hoy.getFullYear(), finMes - 1, 15);
  const hasta = new Date(hoy.getFullYear(), finMes, 14);
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { desde: f(desde), hasta: f(hasta) };
}

const fCorta = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

// ── Grupos que se muestran en el árbol ──────────────────────────────────────

type Grupo = {
  clave: string;
  contraparteId: number | null;
  contraparteNombre: string;
  sedeId: number | null;
  sedeNombre: string;
  sede: Sede | null;
  lineas: LineaAgrupada[];
  /**
   * Líneas calculadas que NO van al documento porque ninguno de sus servicios llegó a
   * 'finalizada'. Antes se descartaban en silencio: una ruta programada y no cerrada
   * desaparecía del cierre sin aparecer ni en rojo ni en ámbar.
   */
  sinEjecutar: LineaAgrupada[];
  /** Todas las reservas del grupo en el periodo, antes de emparejar ida+retorno. */
  reservas: ReservaLiq[];
  /** Servicios facturables (el par ida+retorno cuenta como uno). */
  pares: ParServicio[];
  bloqueadas: ReservaBloqueada[];
  avisos: { r: ReservaLiq; mensaje: string }[];
  total: number;
};

/**
 * ¿Esta reserva entra a la cola del cierre? Fuente ÚNICA de la regla: la usan el árbol
 * de grupos y el panel de "rutas que no entran". Si cada uno la escribiera por su lado,
 * el panel diría que una ruta sí entró justo cuando el árbol la está dejando fuera.
 */
function entraAlCierre(r: ReservaLiq, lado: LadoLiquidacion): boolean {
  if (lado === "cliente")
    return !r.liquidacion_cliente_id && (r.estado_admin === "por_liquidar" || !r.estado_admin);
  return !r.liquidacion_proveedor_id && (r.tipo_asignacion === "tercerizado" || !!r.empresa_tercerizada_id);
}

/**
 * Clave del filtro por contraparte. Los grupos sin cliente / sin empresa también tienen la
 * suya ("sin"): son justo los que hay que poder aislar para arreglarlos, no los que hay
 * que dejar sin forma de encontrar.
 */
const claveContraparte = (id: number | null | undefined) => (id == null ? "sin" : String(id));

/** Opción del desplegable de contraparte. Ojo con las unidades: ver `diasDeServicio`. */
type OpcionContraparte = { clave: string; nombre: string; servicios: number; documentos: number };

/**
 * Servicios de un conjunto de reservas contando el DÍA, no el tramo: la ida y su retorno
 * son uno solo, igual que en la valorización.
 *
 * Contar `reservas.length` habría puesto "130 serv." en el desplegable justo encima de una
 * tarjeta que dice "65 servicio(s)" — el mismo error de unidad que ya se corrigió una vez
 * en la columna PROG./EJEC.
 *
 * Y no se cuenta sobre `pares`, que es lo que usa la tarjeta: una reserva BLOQUEADA nunca
 * llega a ser par, así que un cliente con todo sin precio —justo el que hay que poder
 * aislar para cargárselos— habría aparecido con cero.
 */
function diasDeServicio(rs: ReservaLiq[], hermanoDe: (r: ReservaLiq) => ReservaLiq | null): number {
  const presentes = new Set(rs.map((r) => r.id));
  const vistas = new Set<number>();
  let n = 0;
  for (const r of rs) {
    if (vistas.has(r.id)) continue;
    vistas.add(r.id);
    // El par solo colapsa si el otro tramo está en el mismo conjunto, que es la misma
    // regla que aplica `analizarServicios` — y por el mismo camino: el enlace se lee en
    // los DOS sentidos (lib/liquidacion-hermanos.ts). Leyéndolo solo hacia adelante, un
    // par con el enlace escrito en un lado contaba 2 donde la tarjeta decía 1.
    const otro = hermanoDe(r);
    if (otro && presentes.has(otro.id)) vistas.add(otro.id);
    n++;
  }
  return n;
}

export default function LiquidacionesPage() {
  const [lado, setLado] = useState<LadoLiquidacion>("cliente");
  const [vista, setVista] = useState<"cierre" | "documentos">("cierre");
  const [periodo, setPeriodo] = useState(mesAnterior());
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState("");
  const [errorSql, setErrorSql] = useState("");
  const [trabajando, setTrabajando] = useState(false);

  const [reservas, setReservas] = useState<ReservaLiq[]>([]);
  const [clientes, setClientes] = useState<Record<number, any>>({});
  const [terceros, setTerceros] = useState<Record<number, any>>({});
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [vehiculos, setVehiculos] = useState<Record<string, { placa: string; cap: number | null; categoria: string | null }>>({});
  const [conductores, setConductores] = useState<Record<string, string>>({});
  const [liquidaciones, setLiquidaciones] = useState<any[]>([]);
  const [igvPct, setIgvPct] = useState(18);
  const [usuario, setUsuario] = useState("");
  /** Fichas de rutas contratadas y pax por cotización: los escalones de la cascada del PAX. */
  const [rutas, setRutas] = useState<CatalogoRutas>({ porClave: new Map(), filas: [], disponible: false });
  const [paxCotizacion, setPaxCotizacion] = useState<Map<number, number>>(new Map());

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [abierto, setAbierto] = useState<Set<string>>(new Set());
  const [preciosConIgv, setPreciosConIgv] = useState(false);
  /**
   * Filtro por contraparte: el CLIENTE en la pestaña de facturar, la EMPRESA TERCERIZADA
   * en la de pagar. Una sola caja para las dos porque en cada pestaña solo hay una
   * contraparte posible; se limpia al cambiar de lado porque los ids salen de tablas
   * distintas y un mismo número significaría otra empresa.
   */
  const [filtroContraparte, setFiltroContraparte] = useState("");

  const [editor, setEditor] = useState<number | null>(null);
  const [modalSede, setModalSede] = useState<{ sede: Sede; cliente: string } | null>(null);
  const [enviar, setEnviar] = useState<any | null>(null);
  const [modalCostos, setModalCostos] = useState<ReservaSinCosto[] | null>(null);
  /**
   * Las fichas de capacidad contratada. Es una BANDERA y no la lista congelada al abrir:
   * desde ahí se abre el detalle de los servicios y se corrigen (el nombre de una ruta,
   * por ejemplo), y al recargar la página la tabla del modal tiene que rearmarse sola.
   */
  const [modalRutas, setModalRutas] = useState(false);
  const [modalPrecios, setModalPrecios] = useState<ReservaSinPrecio[] | null>(null);
  /** Los pares ida↔retorno que la base perdió y hay que volver a escribir. */
  const [modalEnlaces, setModalEnlaces] = useState<EnlacePendiente[] | null>(null);
  /**
   * El detalle detrás de un contador. Los tres números de esta pantalla —el "N serv."
   * del bloque rojo, el "N/N serv." de cada línea y el "N servicio(s)" de la cabecera—
   * eran solo texto: cuando uno estaba mal había que ir a Programación a buscar el
   * servicio por código. Ahora se abren y se corrigen aquí.
   */
  const [modalServicios, setModalServicios] = useState<{ titulo: string; subtitulo: string; ids: number[] } | null>(null);

  /** Las reservas del periodo por id: los tres contadores guardan ids, no filas. */
  const reservasPorId = useMemo(() => new Map(reservas.map((r) => [r.id, r])), [reservas]);

  /**
   * El OTRO tramo de cada día, sobre TODO el periodo (lib/liquidacion-hermanos.ts).
   *
   * Se arma acá, antes de partir en grupos, porque el hermano puede quedar fuera del
   * grupo: el filtro `entraAlCierre` deja fuera lo ya liquidado, y la sede se resuelve
   * por patrones de texto que la ida y el retorno no siempre comparten. Con el índice
   * puesto, un retorno en S/ 0.00 cuyo día ya cobra su ida deja de salir como "Sin precio
   * de venta" —que mandaba a cobrarlo por segunda vez— y dice dónde está su tarifa.
   */
  const hermanos = useMemo(() => indiceHermanos(reservas), [reservas]);

  /**
   * Abre el detalle. Recibe ids y no reservas para que los tres orígenes no tengan que
   * cargar lo mismo de tres formas distintas; los ids que ya no estén en el periodo
   * (una fecha editada fuera del rango) simplemente no se listan.
   */
  const verServicios = (titulo: string, subtitulo: string, ids: number[]) =>
    setModalServicios({ titulo, subtitulo, ids: [...new Set(ids)] });

  // ── Carga ────────────────────────────────────────────────────────────────
  async function cargar() {
    setCargando(true); setErrorSql("");
    try {
      const { data: sesion } = await supabase.auth.getSession();
      const correo = sesion?.session?.user?.email ?? "";
      setUsuario(correo);

      // El desempate por id da ORDEN TOTAL. Sin él, `fecha_servicio` empata cientos de
      // veces por página y Postgres puede devolver los empates en distinto orden en cada
      // `range()`: la página 2 repite filas de la 1 y SALTA otras. Un mes con más de
      // 1000 reservas perdía servicios sin ningún error. Es el mismo desempate que ya
      // usan app/programacion y lib/ficha-servicio-datos.
      const traerReservas = (cols: string) =>
        traerTodo(() =>
          supabase.from("reservas").select(cols)
            .gte("fecha_servicio", periodo.desde).lte("fecha_servicio", periodo.hasta)
            .order("fecha_servicio", { ascending: true })
            .order("id", { ascending: true })
        );
      // Dos columnas de migraciones opcionales (liquidaciones-03 y reservas-04). Si esas
      // migraciones no se corrieron, PostgREST rechaza el select ENTERO, así que se
      // reintenta quitándolas de a una: sin el pax la cascada pierde su primer escalón,
      // y sin el origen todo se lee como contratado. Ninguna de las dos puede impedir
      // cerrar el periodo.
      const rs = await traerReservas(`${COLS_RESERVA},${COL_PAX_CONTRATADO},${COL_ORIGEN},${COL_PARADAS}`)
        .catch(() => traerReservas(`${COLS_RESERVA},${COL_PAX_CONTRATADO},${COL_ORIGEN}`))
        .catch(() => traerReservas(`${COLS_RESERVA},${COL_PAX_CONTRATADO}`))
        .catch(() => traerReservas(`${COLS_RESERVA},${COL_ORIGEN}`))
        .catch(() => traerReservas(COLS_RESERVA));
      setReservas(rs as ReservaLiq[]);

      const [cl, te, ve, vt, co, ct, cfg] = await Promise.all([
        supabase.from("clientes").select("id,nombre,empresa,ruc,email,telefono,administrativo_nombre,administrativo_email,administrativo_celular"),
        supabase.from("empresas_tercerizadas").select("id,razon_social,ruc,email,telefono,contacto_nombre,contacto_telefono"),
        supabase.from("vehiculos").select("id,placa,capacidad_pasajeros,categoria"),
        supabase.from("vehiculos_tercero").select("id,placa,capacidad,categoria"),
        supabase.from("conductores").select("id,nombre"),
        supabase.from("conductores_tercero").select("id,nombre"),
        igvVigente(supabase),
      ]);
      const cmap: Record<number, any> = {}; for (const c of ((cl.data as any[]) ?? [])) cmap[c.id] = c;
      const tmap: Record<number, any> = {}; for (const t of ((te.data as any[]) ?? [])) tmap[t.id] = t;
      const vmap: Record<string, any> = {};
      for (const v of ((ve.data as any[]) ?? [])) vmap["p" + v.id] = { placa: v.placa, cap: v.capacidad_pasajeros, categoria: v.categoria };
      for (const v of ((vt.data as any[]) ?? [])) vmap["t" + v.id] = { placa: v.placa, cap: v.capacidad, categoria: v.categoria };
      const comap: Record<string, string> = {};
      for (const c of ((co.data as any[]) ?? [])) comap["p" + c.id] = c.nombre;
      for (const c of ((ct.data as any[]) ?? [])) comap["t" + c.id] = c.nombre;
      // Campos tributarios en consulta aparte y tolerante: si todavía no se corrió
      // supabase/pacto-00-tributario.sql las columnas no existen y PostgREST rechaza
      // el select entero. Sin ellos el modal de costos asume gravado, que es el caso
      // normal de AFA — la pantalla no se cae por una migración pendiente.
      const tt = await supabase
        .from("empresas_tercerizadas")
        .select("id,afectacion_defecto,emite_factura");
      if (!tt.error)
        for (const t of ((tt.data as any[]) ?? []))
          if (tmap[t.id]) Object.assign(tmap[t.id], { afectacion_defecto: t.afectacion_defecto, emite_factura: t.emite_factura });

      setClientes(cmap); setTerceros(tmap); setVehiculos(vmap); setConductores(comap); setIgvPct(cfg);

      // Escalones de la cascada del pax contratado (lib/liquidacion-rutas.ts). Los dos
      // son tolerantes: sin la tabla o sin el campo en la cotización devuelven vacío y
      // el formato simplemente sale sin el "N PAX".
      const [cat, paxCot] = await Promise.all([
        cargarRutasContratadas(supabase),
        cargarPaxDeCotizaciones(supabase, (rs as any[]).map((r) => Number(r.cotizacion_id ?? 0))),
      ]);
      setRutas(cat); setPaxCotizacion(paxCot);

      // Las tablas nuevas pueden no existir todavía: se avisa y la pantalla sigue viva.
      const sd = await supabase.from("cliente_sedes").select("*").eq("activo", true).order("nombre");
      if (sd.error) setErrorSql("Falta correr supabase/liquidaciones-v2.sql en Supabase: sin eso no se puede liquidar ni emitir el formato.");
      setSedes(((sd.data as any[]) ?? []) as Sede[]);

      await cargarLiquidaciones();
    } catch (e: any) {
      setErrorSql(String(e?.message ?? e));
    } finally {
      setCargando(false);
    }
  }

  async function cargarLiquidaciones() {
    const tabla = lado === "cliente" ? "liquidacion_cliente" : "liquidacion_proveedor";
    const { data, error } = await supabase.from(tabla).select("*").order("id", { ascending: false }).limit(200);
    if (!error) setLiquidaciones((data as any[]) ?? []);
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [periodo.desde, periodo.hasta]);
  useEffect(() => {
    cargarLiquidaciones(); setSel(new Set()); setFiltroContraparte("");
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [lado]);

  // ── Catálogo para la agrupación ──────────────────────────────────────────
  const catalogo: CatalogoLiq = useMemo(() => ({
    placaDe: (r) => vehiculos[(r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id)]?.placa ?? "",
    capacidadDe: (r) => vehiculos[(r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id)]?.cap ?? null,
    conductorDe: (r) => conductores[(r.conductor_tercero_id ? "t" : "p") + (r.conductor_tercero_id ?? r.conductor_id)] ?? "",
  }), [vehiculos, conductores]);

  /**
   * "BUS 50 PAX", "CUSTER 25 PAX", "VAN 11 PAX": el TIPO de unidad que cubrió el
   * servicio. La tarifa depende de esto, no de la ruta — una van de 11 no se cobra como
   * un bus de 50—, así que sin este dato a la vista poner un precio es adivinar.
   *
   * Es la categoría del vehículo asignado. NO confundir con la capacidad contratada:
   * esto es lo que salió, aquello lo que el cliente pidió.
   */
  // Se tipa por lo MÍNIMO que necesita, no por ReservaLiq: así sirve igual para las
  // proyecciones más estrechas que usan los modales de carga (ReservaSinCosto no trae
  // vehiculo_id, por ejemplo).
  const unidadDe = useMemo(() => (r: { vehiculo_id?: number | null; vehiculo_tercero_id?: number | null }) => {
    const v = vehiculos[(r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id)];
    if (!v) return "";
    const cat = String(v.categoria ?? "").trim().toUpperCase();
    return [cat || "UNIDAD", v.cap ? `${v.cap} PAX` : ""].filter(Boolean).join(" ");
  }, [vehiculos]);

  /**
   * Sede a la que pertenece un servicio. Prioriza lo escrito en la reserva; si no,
   * usa los patrones de la sede (nombre de ruta, origen, destino); si el cliente
   * tiene una sola sede, esa. Nunca inventa: si no hay match, cae en "sin sede" y
   * el grupo igual se puede liquidar.
   */
  function sedeDe(r: ReservaLiq): Sede | null {
    if (r.cliente_sede_id) return sedes.find((s) => s.id === r.cliente_sede_id) ?? null;
    const delCliente = sedes.filter((s) => s.cliente_id === r.cliente_id);
    if (!delCliente.length) return null;
    if (delCliente.length === 1) return delCliente[0];
    const texto = `${r.ruta_nombre ?? ""} ${r.origen ?? ""} ${r.destino ?? ""}`.toUpperCase();
    return delCliente.find((s) => (s.patrones ?? []).some((p) => p && texto.includes(p))) ?? null;
  }

  // ── Árbol de grupos ──────────────────────────────────────────────────────
  const grupos: Grupo[] = useMemo(() => {
    const candidatas = reservas.filter((r) => entraAlCierre(r, lado));

    const mapa = new Map<string, Grupo>();
    for (const r of candidatas) {
      const contraparteId = lado === "cliente" ? r.cliente_id : (r.empresa_tercerizada_id ?? null);
      const sede = lado === "cliente" ? sedeDe(r) : null;
      const clave = `${contraparteId ?? "x"}|${sede?.id ?? "0"}`;
      const nombre = lado === "cliente"
        ? (contraparteId != null ? (clientes[contraparteId]?.empresa || clientes[contraparteId]?.nombre || `Cliente ${contraparteId}`) : "Sin cliente")
        : (contraparteId != null ? (terceros[contraparteId]?.razon_social || `Empresa ${contraparteId}`) : "Sin empresa");
      const g: Grupo = mapa.get(clave) ?? {
        clave, contraparteId, contraparteNombre: nombre,
        sedeId: sede?.id ?? null, sedeNombre: sede?.nombre ?? (lado === "cliente" ? "Sin sede asignada" : "Servicios tercerizados"),
        sede, lineas: [] as LineaAgrupada[], sinEjecutar: [] as LineaAgrupada[], reservas: [] as ReservaLiq[],
        pares: [] as ParServicio[],
        bloqueadas: [] as ReservaBloqueada[],
        avisos: [] as { r: ReservaLiq; mensaje: string }[], total: 0,
      };
      g.reservas.push(r);
      mapa.set(clave, g);
    }

    for (const g of mapa.values()) {
      // Emparejar ida+retorno ANTES de agrupar: AFA cobra una tarifa por los dos
      // tramos del día, así que la unidad facturable es el par, no la reserva.
      const analisis = analizarServicios(g.reservas, lado, {
        hermanoDe: hermanos.hermanoDe,
        hermanoProbableDe: hermanos.hermanoProbableDe,
        candidatosAmbiguosDe: hermanos.candidatosAmbiguosDe,
      });
      g.pares = analisis.pares;
      g.bloqueadas = analisis.bloqueadas;
      g.avisos = analisis.avisos;

      const todas = agruparServicios(g.pares, {
        lado,
        // La sede del grupo entra en la resolución del pax: las fichas de ruta se
        // guardan por cliente + sede, y aquí la sede puede venir de un patrón y no
        // estar escrita en la reserva.
        catalogo: {
          ...catalogo,
          paxContratadoDe: (par) =>
            resolverPaxContratado(par, { catalogo: rutas, paxCotizacion, sedeId: g.sedeId }),
        },
        preciosIncluyenIgv: preciosConIgv, igvPct,
        sede: g.sede?.nombre ?? null, desde: periodo.desde, hasta: periodo.hasta,
        concepto: g.sede?.servicio_contratado?.replace(/^SERVICIO DE /i, "") || "TRANSPORTE DE PERSONAL",
      });
      // Una línea sin servicios ejecutados no va al documento: solo aportaría un
      // renglón de 0 × S/ 0.00. Pero NO se descarta en silencio — se guarda aparte y
      // se muestra: descartarla sin decir nada era una de las formas de que una ruta
      // entera desapareciera del cierre sin que nadie pudiera decir por qué.
      g.lineas = todas.filter((l) => l.cantidad > 0);
      g.sinEjecutar = todas.filter((l) => l.cantidad === 0);
      g.total = g.lineas.reduce((a, l) => a + l.total_linea, 0);
    }

    return [...mapa.values()].sort((a, b) => b.total - a.total || a.contraparteNombre.localeCompare(b.contraparteNombre));
  }, [reservas, hermanos, lado, clientes, terceros, sedes, catalogo, igvPct, preciosConIgv, periodo.desde, periodo.hasta, rutas, paxCotizacion]);

  /**
   * Lo que el filtro deja ver. Todo lo que se lee de la pantalla —el árbol, el bloque rojo
   * de lo que no entra, los contadores de precios y costos faltantes, las rutas sin
   * capacidad— se calcula sobre ESTO y no sobre `grupos`: cuando alguien filtra por un
   * cliente quiere el trabajo de ese cliente, no un botón que sigue diciendo 399.
   *
   * La SELECCIÓN, en cambio, se sigue leyendo de `grupos` (ver `seleccionados`): filtrar
   * es mirar, no deseleccionar. Si un grupo marcado queda fuera de la vista, la barra lo
   * dice en vez de tirarlo en silencio.
   */
  const gruposVisibles = useMemo(
    () => (filtroContraparte ? grupos.filter((g) => claveContraparte(g.contraparteId) === filtroContraparte) : grupos),
    [grupos, filtroContraparte]
  );

  /**
   * Las contrapartes que se pueden filtrar. Se arman con los grupos por cerrar Y con los
   * documentos ya emitidos: un cliente cuyo mes ya está liquidado no tiene grupos, y sin
   * él en la lista no habría manera de filtrar sus documentos.
   *
   * Las dos cifras NO son del mismo alcance y por eso se rotulan distinto: los servicios
   * son del periodo, los documentos son todos los que lleva emitidos (cargarLiquidaciones
   * trae los últimos 200 sin filtrar por fecha, a propósito: la vista Documentos es un
   * histórico). Decir "N doc. en el periodo" sería falso.
   */
  const opcionesContraparte = useMemo<OpcionContraparte[]>(() => {
    const out = new Map<string, OpcionContraparte>();
    const tocar = (clave: string, nombre: string) => {
      const ya = out.get(clave);
      if (ya) return ya;
      const nuevo: OpcionContraparte = { clave, nombre, servicios: 0, documentos: 0 };
      out.set(clave, nuevo);
      return nuevo;
    };
    for (const g of grupos)
      tocar(claveContraparte(g.contraparteId), g.contraparteNombre).servicios +=
        diasDeServicio(g.reservas, hermanos.hermanoDe);
    for (const l of liquidaciones) {
      const id = (lado === "cliente" ? l.cliente_id : l.empresa_tercerizada_id) ?? null;
      const nombre = lado === "cliente"
        ? (id != null ? (clientes[id]?.empresa || clientes[id]?.nombre || `Cliente ${id}`) : "Sin cliente")
        : (id != null ? (terceros[id]?.razon_social || `Empresa ${id}`) : "Sin empresa");
      tocar(claveContraparte(id), nombre).documentos += 1;
    }
    return [...out.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [grupos, hermanos, liquidaciones, clientes, terceros, lado]);

  /**
   * El filtro apunta a alguien que no tiene nada en este periodo (se movió el rango de
   * fechas con el filtro puesto). Se ignora mientras carga: ahí la lista está vacía por
   * un instante y no porque el cliente no tenga servicios.
   */
  const filtroHuerfano =
    !!filtroContraparte && !cargando && !opcionesContraparte.some((o) => o.clave === filtroContraparte);

  /** Los documentos emitidos, pasados por el mismo filtro. */
  const liquidacionesVisibles = useMemo(
    () => (filtroContraparte
      ? liquidaciones.filter((l) => claveContraparte((lado === "cliente" ? l.cliente_id : l.empresa_tercerizada_id) ?? null) === filtroContraparte)
      : liquidaciones),
    [liquidaciones, filtroContraparte, lado]
  );

  /**
   * Las rutas del periodo con su capacidad contratada. Alimenta el modal de fichas y el
   * contador de "sin capacidad contratada": son las que saldrán sin el "N PAX".
   */
  const rutasDelPeriodo = useMemo<RutaDelPeriodo[]>(() => {
    const out = new Map<string, RutaDelPeriodo>();
    for (const g of gruposVisibles)
      for (const l of g.lineas) {
        const k = `${g.contraparteId ?? 0}|${g.sedeId ?? 0}|${l.nombre_ida ?? ""}|${l.nombre_retorno ?? ""}`;
        // La ficha NO se parte por origen: la capacidad contratada es de la RUTA, y
        // `cliente_ruta` la identifica por el par de nombres. Pero se cuenta cuántos de
        // esos servicios fueron adicionales, para poder decirlo en la fila.
        const adics = l.tipo === "adicional" ? l.cantidad : 0;
        const ya = out.get(k);
        if (ya) {
          ya.servicios += l.cantidad;
          ya.adicionales += adics;
          // Los tramos y el dinero de TODAS las líneas que caen en la misma ficha: la
          // ficha no se parte por móvil ni por origen, así que su detalle tampoco. Las
          // tarifas se acumulan DISTINTAS, no promediadas: con un adicional a otro precio,
          // un promedio mostraría un importe que no se le cobró a nadie.
          ya.reservasPeriodo.push(...l.reservas_periodo);
          if (!ya.precios.includes(l.precio_unitario)) ya.precios.push(l.precio_unitario);
          ya.total += l.total_linea;
          continue;
        }
        out.set(k, {
          clave: k,
          clienteId: g.contraparteId,
          clienteNombre: g.contraparteNombre,
          sedeId: g.sedeId,
          sedeNombre: g.sedeNombre,
          nombreIda: l.nombre_ida,
          nombreRetorno: l.nombre_retorno,
          paxContratado: l.pax_contratado,
          capacidadMinimaAsignada: l.capacidad_minima_asignada,
          servicios: l.cantidad,
          reservasPeriodo: [...l.reservas_periodo],
          precios: [l.precio_unitario],
          total: l.total_linea,
          adicionales: adics,
        });
      }
    return [...out.values()]
      // Las tarifas ordenadas: la fila muestra el rango, y un rango al revés se lee como
      // un error de la pantalla y no como las dos tarifas que de verdad tiene la ruta.
      .map((r) => ({ ...r, precios: [...r.precios].sort((a, b) => a - b) }))
      .sort((a, b) => String(a.nombreIda).localeCompare(String(b.nombreIda)));
  }, [gruposVisibles]);

  /** Rutas que van a imprimirse sin el "N PAX" porque ninguna fuente sabe cuánto se contrató. */
  const rutasSinPax = useMemo(
    () => (lado === "cliente" ? rutasDelPeriodo.filter((r) => !r.paxContratado) : []),
    [rutasDelPeriodo, lado]
  );

  const seleccionados = grupos.filter((g) => sel.has(g.clave) && g.lineas.length);
  const totalSeleccionado = seleccionados.reduce((a, g) => a + g.total, 0);
  /**
   * Grupos marcados que el filtro dejó fuera de la vista. Se cuentan para poder decirlo:
   * el botón liquida TODO lo marcado, y un grupo que se liquida sin verse es exactamente
   * la sorpresa que este módulo existe para evitar.
   */
  const seleccionOculta = useMemo(() => {
    const visibles = new Set(gruposVisibles.map((g) => g.clave));
    return seleccionados.filter((g) => !visibles.has(g.clave)).length;
  }, [seleccionados, gruposVisibles]);

  /**
   * Los servicios que el bloque rojo marca "Sin costo de proveedor". Antes solo se
   * podían mirar: había que ir a Programación uno por uno, sin saber cuánto se pactó.
   * Ahora alimentan el modal que los carga en lote y desbloquea el cierre del mes.
   */
  const sinCosto = useMemo<ReservaSinCosto[]>(() => {
    if (lado !== "proveedor") return [];
    const vistos = new Set<number>();
    const out: ReservaSinCosto[] = [];
    for (const g of gruposVisibles)
      for (const { r, codigos } of g.bloqueadas) {
        if (!codigos.includes("sin_costo")) continue;
        if (vistos.has(r.id)) continue;
        vistos.add(r.id);
        out.push(r as ReservaSinCosto);
      }
    return out;
  }, [gruposVisibles, lado]);

  /**
   * Espejo del anterior para el lado CLIENTE. Faltaba, y esa asimetría es la que hizo
   * que una ruta entera se quedara fuera de un cierre sin forma cómoda de arreglarlo:
   * el bloque rojo decía "Sin precio de venta" y había que ir a Programación servicio
   * por servicio, sesenta veces.
   */
  const sinPrecio = useMemo<ReservaSinPrecio[]>(() => {
    if (lado !== "cliente") return [];
    const vistos = new Set<number>();
    const out: ReservaSinPrecio[] = [];
    for (const g of gruposVisibles)
      for (const { r, codigos } of g.bloqueadas) {
        // Solo los que de verdad NO tienen tarifa en ningún tramo del día. Un retorno
        // cuyo día ya cobra su ida sale con otro código (`falta_enlace`,
        // `tarifa_fuera_del_cierre`) y NO entra acá: ponerle un precio cobraría el día
        // dos veces, que es justo lo que este módulo existe para impedir.
        if (!codigos.includes("sin_precio")) continue;
        if (vistos.has(r.id)) continue;
        vistos.add(r.id);
        out.push({ ...(r as ReservaSinPrecio), clienteNombre: g.contraparteNombre });
      }
    return out;
  }, [gruposVisibles, lado]);

  /**
   * Los días partidos en dos porque les falta el enlace ida↔retorno.
   *
   * Se arman sobre el PERIODO y no sobre los bloqueados: un par con el enlace escrito en
   * un solo lado ya no bloquea nada —el cierre lo empareja igual, mirando el enlace por
   * los dos sentidos— pero sigue roto para Programación y para las notificaciones, que lo
   * leen hacia adelante. El que sí bloquea es el que no tiene enlace por ningún lado.
   *
   * Se limita a las reservas que se están mirando (el filtro por contraparte incluido):
   * un botón que ofrece arreglar cosas que no están en pantalla es el mismo problema que
   * el contador que decía 399.
   */
  const enlacesRotos = useMemo<EnlacePendiente[]>(() => {
    const visibles = new Set<number>();
    for (const g of gruposVisibles) for (const r of g.reservas) visibles.add(r.id);
    return hermanos.pendientes.filter(
      (e) => visibles.has(e.tramo.id) || (e.propuesto ? visibles.has(e.propuesto.id) : false)
    );
  }, [hermanos, gruposVisibles]);

  /**
   * Lo que NO entra al cierre, agrupado POR RUTA y con su motivo.
   *
   * Es la pregunta que de verdad se hace quien cierra el mes ("¿por qué no sale la
   * RUTA A?") y la que la pantalla no sabía contestar: el detalle existía, pero como
   * una lista de códigos de servicio sueltos, recortada a ocho filas y escondida
   * dentro de una tarjeta plegada. Con sesenta servicios bloqueados eso se leía como
   * "y 52 más…" y no nombraba la ruta ni una vez.
   */
  const fueraDelCierre = useMemo(() => {
    type Fila = { clave: string; grupo: string; contraparte: string; ruta: string; motivo: string; servicios: number; ids: number[] };
    const out = new Map<string, Fila>();
    const sumar = (grupo: string, contraparte: string, ruta: string, motivo: string, id: number) => {
      const clave = `${grupo}|${ruta}|${motivo}`;
      const ya = out.get(clave);
      if (ya) { ya.servicios += 1; ya.ids.push(id); return; }
      out.set(clave, { clave, grupo, contraparte, ruta, motivo, servicios: 1, ids: [id] });
    };
    for (const g of gruposVisibles) {
      const donde = g.sedeNombre && g.sedeNombre !== "Servicios tercerizados" ? `${g.contraparteNombre} · ${g.sedeNombre}` : g.contraparteNombre;
      const quien = claveContraparte(g.contraparteId);
      for (const { r, motivos } of g.bloqueadas)
        // El motivo se despersonaliza (#1234 → #…) para que sesenta servicios con el
        // mismo problema sean UNA fila y no sesenta.
        sumar(donde, quien, etiquetaRuta(r), (motivos[0] ?? "Bloqueada").replace(/#\d+/g, "#…"), r.id);
      for (const l of g.sinEjecutar)
        for (const id of l.reservas_periodo)
          sumar(donde, quien, l.ruta, `Programada pero ningún servicio quedó finalizado (${l.cantidad_programada})`, id);
    }
    return [...out.values()].sort((a, b) => b.servicios - a.servicios || a.ruta.localeCompare(b.ruta));
  }, [gruposVisibles]);

  /**
   * Mover el periodo INVALIDA la selección. `g.clave` es cliente|sede y no lleva fechas,
   * así que un grupo marcado en agosto seguía marcado al cambiar a julio: visible, sin
   * aviso —el contador de "fuera del filtro" no lo ve porque el filtro no tiene que ver—
   * y "Liquidar" emitía el documento del mes equivocado. Es el único camino que quedaba
   * para que saliera un documento inesperado sin que nadie lo dijera.
   */
  function cambiarPeriodo(p: { desde: string; hasta: string }) {
    setPeriodo(p);
    setSel(new Set());
  }

  function toggle(clave: string) {
    setSel((s) => { const n = new Set(s); n.has(clave) ? n.delete(clave) : n.add(clave); return n; });
  }
  function toggleAbierto(clave: string) {
    setAbierto((s) => { const n = new Set(s); n.has(clave) ? n.delete(clave) : n.add(clave); return n; });
  }

  // ── Acciones ─────────────────────────────────────────────────────────────

  async function liquidarSeleccion() {
    if (!seleccionados.length) { setMsg("⚠️ Marca al menos un grupo."); return; }
    setTrabajando(true); setMsg("");
    try {
      const res = await crearLiquidaciones(supabase,
        seleccionados.map((g) => ({
          contraparteId: g.contraparteId,
          sedeId: g.sedeId,
          lineas: g.lineas,
          cabecera: {
            area_solicitante: g.sede?.area_solicitante ?? g.sede?.nombre ?? null,
            usuario_solicita: g.sede?.usuario_solicita ?? null,
            cargo_solicita: g.sede?.cargo_solicita ?? null,
            servicio_contratado: g.sede?.servicio_contratado ?? null,
            ubicacion_servicio: g.sede?.ubicacion_servicio ?? g.sede?.nombre ?? null,
            orden_compra: g.sede?.orden_compra ?? null,
            moneda: g.sede?.moneda ?? "PEN",
            responsable_afa: lado === "proveedor" ? usuario : null,
          },
        })),
        {
          lado, periodoDesde: periodo.desde, periodoHasta: periodo.hasta,
          periodoLabel: `${fCorta(periodo.desde)} AL ${fCorta(periodo.hasta)}`,
          igvPct, preciosIncluyenIgv: preciosConIgv, usuario,
        });

      const ok = res.creadas.length;
      setMsg(
        `${ok ? "✅" : "⚠️"} ${ok} liquidación(es) creada(s) en borrador${res.errores.length ? ` · ${res.errores.length} con problemas: ${res.errores[0]}` : ""}.`
      );
      setSel(new Set());
      setVista("documentos");
      await cargar();
    } finally { setTrabajando(false); }
  }

  /** Abre el documento en una ventana nueva, listo para imprimir o guardar como PDF. */
  async function verPdf(id: number) {
    setTrabajando(true);
    try {
      const fila = liquidaciones.find((l) => l.id === id);
      const url = fila?.token ? `${location.origin}/conformidad/${fila.token}` : null;
      const doc = await cargarDocumentoLiquidacion(supabase, lado, { id }, { urlPublica: url });
      if (!doc) { setMsg("⚠️ No se pudo armar el documento."); return; }
      const win = window.open("", "_blank");
      if (!win) { setMsg("⚠️ El navegador bloqueó la ventana emergente."); return; }
      win.document.write(
        buildLiquidacionHtml(doc).replace("</body>", "<script>window.onload=()=>setTimeout(()=>window.print(),350);<\/script></body>")
      );
      win.document.close();
    } finally { setTrabajando(false); }
  }

  async function aprobar(l: any) {
    const texto = lado === "cliente"
      ? `¿Aprobar ${l.codigo} y emitir la factura por ${fmtMoneda(Number(l.total ?? 0), l.moneda)}?`
      : `¿Aprobar ${l.codigo} y generar la cuenta por pagar por ${fmtMoneda(Number(l.total ?? 0), l.moneda)}?`;
    if (!confirm(texto)) return;
    setTrabajando(true);
    const r = lado === "cliente"
      ? await aprobarLiquidacionCliente(supabase, l.id, usuario)
      : await aprobarLiquidacionProveedor(supabase, l.id, usuario);
    setMsg(r.ok
      ? (lado === "cliente" ? `✅ Facturada (factura #${(r as any).factura_id}).` : `✅ Aprobada.${(r as any).aviso ? " " + (r as any).aviso : ` Cuenta por pagar #${(r as any).documento_compra_id}.`}`)
      : `⚠️ ${r.error}`);
    await cargar(); setTrabajando(false);
  }

  async function anular(l: any) {
    const motivo = prompt(`Motivo de la anulación de ${l.codigo}:`);
    if (!motivo) return;
    setTrabajando(true);
    const r = await anularLiquidacion(supabase, lado, l.id, motivo, usuario);
    // Se dice el NÚMERO. "Sus servicios volvieron" era una promesa que nadie verificaba:
    // si la liberación fallaba, el mensaje salía igual de verde.
    setMsg(r.ok
      ? `✅ ${r.yaEstaba ? "Ya estaba anulada" : "Anulada"} · ${r.liberados ?? 0} servicio(s) ` +
        `volvieron a estar ${lado === "cliente" ? "por liquidar" : "por conciliar"}.`
      : `⚠️ ${r.error}`);
    await cargar(); setTrabajando(false);
  }

  /**
   * Servicios que quedaron con su FK apuntando a un documento ANULADO. No deberían
   * existir —anular los devuelve al pool—, pero si la liberación falló alguna vez, el
   * pool del cierre los excluye para siempre y en pantalla no se ve nada: el periodo
   * simplemente sale con menos servicios de los que hubo.
   */
  const retenidos = useMemo(() => {
    const anuladas = new Map<number, string>(
      liquidaciones.filter((l) => l.estado === "anulada").map((l) => [Number(l.id), String(l.codigo ?? `#${l.id}`)])
    );
    if (!anuladas.size) return [] as { id: number; codigo: string; servicios: number }[];
    const fk = lado === "cliente" ? "liquidacion_cliente_id" : "liquidacion_proveedor_id";
    const cuenta = new Map<number, number>();
    for (const r of reservas) {
      const ref = Number((r as any)[fk] ?? 0);
      if (ref && anuladas.has(ref)) cuenta.set(ref, (cuenta.get(ref) ?? 0) + 1);
    }
    return [...cuenta.entries()].map(([id, servicios]) => ({ id, codigo: anuladas.get(id)!, servicios }));
  }, [reservas, liquidaciones, lado]);

  const totalRetenidos = retenidos.reduce((a, x) => a + x.servicios, 0);

  async function liberarRetenidos() {
    setTrabajando(true); setMsg("");
    let n = 0;
    for (const x of retenidos) {
      const r = await liberarServicios(supabase, lado, x.id);
      if (!r.ok) { setMsg(`⚠️ ${x.codigo}: ${r.error}`); setTrabajando(false); return; }
      n += r.liberados ?? 0;
    }
    setMsg(`✅ ${n} servicio(s) liberados. Ya vuelven a aparecer en el cierre.`);
    await cargar(); setTrabajando(false);
  }

  async function reabrir(l: any) {
    setTrabajando(true);
    const r = await volverABorrador(supabase, lado, l.id, usuario);
    setMsg(r.ok ? "✅ Reabierta como borrador." : `⚠️ ${r.error}`);
    await cargar(); setTrabajando(false);
  }

  const cp = lado === "cliente" ? "#0b315f" : "#6d28d9";

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto pb-16">
      <div className="mb-4">
        <h1 className="text-2xl font-black" style={{ color: cp }}>Liquidaciones</h1>
        <p className="text-sm text-gray-500">
          Cierre del periodo: valoriza los servicios ejecutados, emite el Formato de Liquidación y Conformidad, y recién ahí factura o paga.
        </p>
      </div>

      {/* Pestañas */}
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        {(["cliente", "proveedor"] as const).map((t) => (
          <button key={t} onClick={() => setLado(t)}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition ${lado === t ? "text-white shadow" : "bg-white text-gray-600 hover:bg-gray-50 border"}`}
            style={lado === t ? { background: t === "cliente" ? "#0b315f" : "#6d28d9" } : {}}>
            {t === "cliente" ? "Al Cliente (facturar)" : "Al Proveedor (pagar)"}
          </button>
        ))}
        <div className="w-px h-7 bg-gray-200 mx-1" />
        {(["cierre", "documentos"] as const).map((v) => (
          <button key={v} onClick={() => setVista(v)}
            className={`px-3 py-2 rounded-xl text-sm font-bold ${vista === v ? "bg-gray-900 text-white" : "bg-white text-gray-600 border hover:bg-gray-50"}`}>
            {v === "cierre" ? "Cerrar periodo" : `Documentos (${liquidacionesVisibles.length})`}
          </button>
        ))}
        <button onClick={cargar} className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold bg-white border hover:bg-gray-50">↻ Recargar</button>
      </div>

      {errorSql && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
          <b>Falta un paso en la base de datos.</b> {errorSql}
        </div>
      )}
      {msg && <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

      {/* Servicios que quedaron atrapados en un documento anulado. Si el sistema puede
          detectar el desastre, que lo diga — y que lo sepa deshacer. */}
      {totalRetenidos > 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-900 flex flex-wrap items-center gap-3">
          <span className="flex-1 min-w-[18rem]">
            <b>{totalRetenidos} servicio(s) siguen retenidos por documentos anulados</b>{" "}
            ({retenidos.map((x) => `${x.codigo}: ${x.servicios}`).join(" · ")}).
            No aparecen en el cierre aunque su liquidación ya no exista.
          </span>
          <button onClick={liberarRetenidos} disabled={trabajando}
            className="px-3 py-2 rounded-xl text-sm font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-40">
            {trabajando ? "Liberando…" : `Liberar ${totalRetenidos} servicio(s)`}
          </button>
        </div>
      )}

      {/* Filtros de periodo */}
      <div className="bg-gray-50 border rounded-2xl p-3 mb-4 flex flex-wrap gap-2 items-center">
        <span className="text-xs font-black text-gray-500 uppercase tracking-wide">Periodo</span>
        <input type="date" value={periodo.desde} onChange={(e) => cambiarPeriodo({ ...periodo, desde: e.target.value })}
          className="px-3 py-1.5 rounded-xl border text-sm" />
        <span className="text-gray-400 text-sm">al</span>
        <input type="date" value={periodo.hasta} onChange={(e) => cambiarPeriodo({ ...periodo, hasta: e.target.value })}
          className="px-3 py-1.5 rounded-xl border text-sm" />
        <button onClick={() => cambiarPeriodo(mesAnterior())} className="px-3 py-1.5 rounded-xl border bg-white text-xs font-bold hover:bg-gray-50">Mes pasado</button>
        <button onClick={() => cambiarPeriodo(quincena15())} className="px-3 py-1.5 rounded-xl border bg-white text-xs font-bold hover:bg-gray-50">Del 15 al 14</button>

        {/* Filtro por contraparte. Un cierre real tiene diez clientes y cuatrocientos
            servicios en la misma pantalla; sin esto, atender a uno obliga a leer los diez. */}
        <div className="w-px h-6 bg-gray-200 mx-1" />
        <span className="text-xs font-black text-gray-500 uppercase tracking-wide">
          {lado === "cliente" ? "Cliente" : "Proveedor"}
        </span>
        <select value={filtroContraparte} onChange={(e) => setFiltroContraparte(e.target.value)}
          className={`px-3 py-1.5 rounded-xl border text-sm max-w-[22rem] ${filtroContraparte ? "font-bold bg-white" : "text-gray-600"}`}
          style={filtroContraparte ? { borderColor: cp, color: cp } : {}}>
          <option value="">
            {lado === "cliente" ? "Todos los clientes" : "Todos los proveedores"}
          </option>
          {opcionesContraparte.map((o) => (
            <option key={o.clave} value={o.clave}>
              {o.nombre}
              {o.servicios ? ` · ${o.servicios} serv.` : ""}
              {o.documentos ? ` · ${o.documentos} doc. emitido(s)` : ""}
            </option>
          ))}
          {/* El filtro puede sobrevivir a un cambio de periodo en el que ese cliente no
              tiene nada: sin esta opción el desplegable se vería en blanco y la pantalla
              vacía no tendría explicación. */}
          {filtroHuerfano && (
            <option value={filtroContraparte}>Sin servicios ni documentos en este periodo</option>
          )}
        </select>
        {filtroContraparte && (
          <button onClick={() => setFiltroContraparte("")}
            className="px-2.5 py-1.5 rounded-xl border bg-white text-xs font-bold text-gray-500 hover:bg-gray-50"
            title="Quitar el filtro">✕</button>
        )}

        <label className="ml-auto flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={preciosConIgv} onChange={(e) => setPreciosConIgv(e.target.checked)} />
          Los precios del ERP ya incluyen IGV
        </label>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-gray-400">Cargando el periodo…</div>
      ) : vista === "cierre" ? (
        <>
          {/* Barra de acción masiva */}
          <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border rounded-2xl p-3 mb-3 flex flex-wrap items-center gap-3 shadow-sm">
            <span className="text-sm text-gray-600">
              <b>{gruposVisibles.length}</b> grupo(s)
              {filtroContraparte ? ` de ${grupos.length} en el periodo` : " en el periodo"} ·{" "}
              <b>{seleccionados.length}</b> seleccionado(s)
              {seleccionOculta > 0 && (
                <span className="text-amber-700 font-semibold"> ({seleccionOculta} fuera del filtro)</span>
              )}
            </span>
            <span className="font-black" style={{ color: cp }}>{fmtMoneda(totalSeleccionado)}</span>
            {sinCosto.length > 0 && (
              <button onClick={() => setModalCostos(sinCosto)}
                className="px-3 py-2 rounded-xl text-sm font-bold text-red-700 bg-red-50 border border-red-200 hover:bg-red-100">
                Cargar {sinCosto.length} costo(s) faltante(s)
              </button>
            )}
            {sinPrecio.length > 0 && (
              <button onClick={() => setModalPrecios(sinPrecio)}
                className="px-3 py-2 rounded-xl text-sm font-bold text-red-700 bg-red-50 border border-red-200 hover:bg-red-100">
                Cargar {sinPrecio.length} precio(s) de venta faltante(s)
              </button>
            )}
            {/* Un día partido en dos no es un precio que falta: es un enlace que falta. Y
                la diferencia importa, porque "arreglarlo" con un precio cobra el día dos
                veces. Por eso es su propio botón y no una fila más del de precios. */}
            {enlacesRotos.length > 0 && (() => {
              // Los ambiguos se cuentan aparte porque son trabajo distinto: ahí el hermano
              // lo elige el operador. Meterlos en el mismo número haría creer que el ERP
              // ya sabe cuál va con cuál — que es justo el error que costó un falso par.
              const aElegir = enlacesRotos.filter((e) => !e.propuesto).length;
              return (
                <button onClick={() => setModalEnlaces(enlacesRotos)}
                  className="px-3 py-2 rounded-xl text-sm font-bold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100"
                  title="Días partidos en dos servicios sueltos: les falta el enlace ida↔retorno">
                  Enlazar {enlacesRotos.length} tramo(s) ida↔retorno
                  {aElegir > 0 && ` · ${aElegir} a elegir`}
                </button>
              );
            })()}
            {lado === "cliente" && rutasDelPeriodo.length > 0 && (
              <button onClick={() => setModalRutas(true)}
                className={`px-3 py-2 rounded-xl text-sm font-bold border ${
                  rutasSinPax.length
                    ? "text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100"
                    : "text-gray-600 bg-white hover:bg-gray-50"
                }`}>
                {rutasSinPax.length
                  ? `${rutasSinPax.length} ruta(s) sin capacidad contratada`
                  : "Rutas contratadas"}
              </button>
            )}
            <button disabled={trabajando || !seleccionados.length} onClick={liquidarSeleccion}
              className="ml-auto px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
              {trabajando ? "Generando…" : `Liquidar ${seleccionados.length || ""} grupo(s) → ${seleccionados.length || 0} documento(s)`}
            </button>
          </div>

          {/* Qué NO va a salir en la liquidación, y por qué. Agrupado por ruta y visible
              siempre: es la primera pregunta de quien cierra el mes, y antes había que
              desplegar la tarjeta para encontrar la respuesta partida en códigos sueltos. */}
          {fueraDelCierre.length > 0 && (
            <div className="bg-white rounded-2xl border border-red-200 shadow-sm mb-3 overflow-hidden">
              <div className="px-4 py-2 bg-red-50 border-b">
                <p className="text-[11px] font-black text-red-700 uppercase tracking-wide">
                  No entran a la liquidación ({fueraDelCierre.reduce((a, f) => a + f.servicios, 0)} servicios)
                </p>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {fueraDelCierre.map((f) => (
                    <tr key={f.clave}>
                      <td className="px-4 py-1.5 font-medium text-gray-800 w-48">{f.ruta}</td>
                      {/* El nombre filtra: con diez clientes en la lista, "¿por qué no sale
                          la RUTA A?" se responde aislando al que la contrató. */}
                      <td className="px-2 py-1.5 text-xs text-gray-400">
                        <button onClick={() => setFiltroContraparte(f.contraparte)}
                          className="text-left hover:text-gray-700 hover:underline"
                          title={`Filtrar por ${lado === "cliente" ? "este cliente" : "este proveedor"}`}>
                          {f.grupo}
                        </button>
                      </td>
                      {/* El contador abre el detalle: es el sitio donde de verdad se
                          arregla el motivo por el que esos servicios no entran. */}
                      <td className="px-2 py-1.5 text-xs text-right w-24">
                        <button onClick={() => verServicios(f.ruta, `${f.grupo} · ${f.motivo}`, f.ids)}
                          className="font-bold text-red-700 underline decoration-dotted hover:text-red-900"
                          title="Ver y corregir estos servicios">
                          {f.servicios} serv.
                        </button>
                      </td>
                      <td className="px-4 py-1.5 text-xs text-red-700">{f.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {gruposVisibles.length === 0 ? (
            <div className="bg-white rounded-2xl border p-10 text-center text-gray-400">
              {filtroContraparte ? (
                <>
                  {lado === "cliente" ? "Ese cliente" : "Ese proveedor"} no tiene servicios{" "}
                  {lado === "cliente" ? "por liquidar" : "por conciliar"} en este periodo.
                  {grupos.length > 0 && (
                    <button onClick={() => setFiltroContraparte("")} className="ml-2 underline font-semibold text-gray-500 hover:text-gray-700">
                      Ver los {grupos.length} grupo(s) del periodo
                    </button>
                  )}
                </>
              ) : (
                <>No hay servicios {lado === "cliente" ? "por liquidar" : "tercerizados por conciliar"} en este periodo. 🎉</>
              )}
            </div>
          ) : gruposVisibles.map((g) => {
            const abiertoG = abierto.has(g.clave);
            const listo = g.lineas.length > 0;
            return (
              <div key={g.clave} className={`bg-white rounded-2xl border shadow-sm mb-3 overflow-hidden ${!listo ? "border-red-200" : ""}`}>
                <div className={`flex items-center gap-3 px-4 py-3 border-b ${listo ? "bg-gray-50" : "bg-red-50"}`}>
                  <input type="checkbox" disabled={!listo} checked={sel.has(g.clave)} onChange={() => toggle(g.clave)} />
                  <button onClick={() => toggleAbierto(g.clave)} className="text-left flex-1">
                    <span className="font-bold" style={{ color: listo ? cp : "#991b1b" }}>{g.contraparteNombre}</span>
                    <span className="text-xs text-gray-500 ml-2">{g.sedeNombre}</span>
                  </button>
                  {/* El contador del grupo abre TODOS sus tramos del periodo —incluidos
                      los bloqueados y los que no se ejecutaron—, que es lo que hay que
                      poder revisar cuando el número no cuadra. */}
                  <button
                    onClick={() => verServicios(g.contraparteNombre, g.sedeNombre, g.reservas.map((r) => r.id))}
                    className="text-xs text-gray-400 underline decoration-dotted hover:text-gray-700"
                    title="Ver el detalle de estos servicios">
                    {g.pares.filter((p) => p.ejecutado).length} servicio(s)
                    {g.pares.some((p) => p.adjuntas.length) ? " (ida y retorno)" : ""}
                    {g.bloqueadas.length ? ` · ${g.bloqueadas.length} con problema` : ""}
                  </button>
                  {lado === "cliente" && (
                    <button
                      onClick={() => setModalSede({
                        sede: g.sede ?? SEDE_VACIA(g.contraparteId),
                        cliente: g.contraparteNombre,
                      })}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold border hover:bg-white">
                      {g.sede ? "✎ Sede" : "+ Crear sede"}
                    </button>
                  )}
                  <span className="font-black text-gray-700">{fmtMoneda(g.total)}</span>
                  <span className="text-gray-400 text-xs">{abiertoG ? "▲" : "▼"}</span>
                </div>

                {!g.sede && lado === "cliente" && (
                  <div className="px-4 py-2 bg-amber-50 border-b text-[11px] text-amber-800">
                    Este grupo no tiene sede: el formato saldrá sin área solicitante ni usuario que aprueba, y no habrá a quién enviarle la conformidad.
                  </div>
                )}

                {abiertoG && (
                  <div className="divide-y">
                    {g.lineas.map((l) => {
                      // La unidad más chica del periodo por debajo de lo contratado es un
                      // incumplimiento que hasta ahora no se veía: no había capacidad
                      // contratada contra la cual compararla.
                      const unidadCorta =
                        l.pax_contratado != null &&
                        l.capacidad_minima_asignada != null &&
                        l.capacidad_minima_asignada < l.pax_contratado;
                      return (
                        <div key={l.clave} className="flex items-start gap-3 px-4 py-2 text-sm"
                             style={l.tipo === "adicional" ? { background: "#fffbeb" } : undefined}>
                          <span className="flex-1 text-gray-700">
                            {/* El nombre completo de cada tramo, que es lo que se imprime. */}
                            <span className="block">
                              {l.tipo === "adicional" && (
                                <span className="mr-1.5 text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase align-middle"
                                      title="Fuera del contrato: va en el subtotal de adicionales del formato"
                                      style={{ background: "#fef3c7", color: "#b45309" }}>
                                  {l.origen_contractual}
                                </span>
                              )}
                              {l.nombre_ida ?? l.ruta}
                            </span>
                            {l.nombre_retorno && (
                              <span className="block text-gray-500">↩ {l.nombre_retorno}</span>
                            )}
                            <span className="block text-[11px] text-gray-400">
                              {l.pax_contratado ? `${l.pax_contratado} PAX contratados` : "sin capacidad contratada"}
                              {l.moviles > 1 ? ` · Móvil ${l.movil} de ${l.moviles}` : ""}
                              {l.placas.length ? ` · ${l.placas.join(", ")}` : ""}
                            </span>
                            {unidadCorta && (
                              <span className="block text-[11px] text-amber-700">
                                ⚠ Se asignó una unidad de {l.capacidad_minima_asignada} asientos, por debajo de los {l.pax_contratado} contratados.
                              </span>
                            )}
                          </span>
                          {/* Se abren las reservas DEL PERIODO, no solo las cobradas: si
                              la línea dice 4/5, el servicio que falta es justo el que hay
                              que ver, y `reservas` (las ejecutadas) no lo trae. */}
                          <span className="text-xs text-gray-500 whitespace-nowrap">
                            <button
                              onClick={() => verServicios(
                                l.nombre_ida ?? l.ruta,
                                [g.contraparteNombre, l.nombre_retorno ? `↩ ${l.nombre_retorno}` : "", l.moviles > 1 ? `Móvil ${l.movil} de ${l.moviles}` : ""].filter(Boolean).join(" · "),
                                l.reservas_periodo
                              )}
                              className="underline decoration-dotted hover:text-gray-800 font-semibold"
                              title="Ver y editar estos servicios">
                              {l.cantidad_ejecutada}/{l.cantidad_programada} serv.
                            </button>
                            {" × "}{fmtMoneda(l.precio_unitario)}
                          </span>
                          <span className="w-28 text-right font-bold text-gray-700">{fmtMoneda(l.total_linea)}</span>
                        </div>
                      );
                    })}
                    {g.avisos.length > 0 && (
                      <div className="px-4 py-3 bg-amber-50/60">
                        <p className="text-[11px] font-black text-amber-700 uppercase tracking-wide mb-1">Revisa antes de emitir</p>
                        {/* La clave lleva el índice porque una MISMA reserva puede traer dos
                            avisos: desde que el par se cobra por día (lib/liquidacion-agrupacion),
                            un tramo caído que además lleva el importe dispara los dos. Con
                            key={r.id} eso era una clave duplicada en React. */}
                        {g.avisos.slice(0, 6).map(({ r, mensaje }, i) => (
                          <div key={`${r.id}-${i}`} className="text-[11px] text-amber-800 flex gap-2">
                            <span className="font-mono">{r.codigo ?? "#" + r.id}</span>
                            <span>{mensaje}</span>
                          </div>
                        ))}
                        {g.avisos.length > 6 && <p className="text-[11px] text-amber-600 mt-1">y {g.avisos.length - 6} más…</p>}
                      </div>
                    )}
                    {g.bloqueadas.length > 0 && (
                      <div className="px-4 py-3 bg-red-50/60">
                        <p className="text-[11px] font-black text-red-700 uppercase tracking-wide mb-1">No se pueden liquidar todavía</p>
                        {g.bloqueadas.slice(0, 8).map(({ r, motivos }) => (
                          <div key={r.id} className="text-[11px] text-red-700 flex gap-2">
                            <span className="font-mono">{r.codigo ?? "#" + r.id}</span>
                            <span className="text-red-400">{r.fecha_servicio}</span>
                            <span className="text-red-400">{r.direccion_servicio === "retorno" ? "retorno" : "ida"}</span>
                            <span>{motivos.join(" · ")}</span>
                          </div>
                        ))}
                        {g.bloqueadas.length > 8 && <p className="text-[11px] text-red-500 mt-1">y {g.bloqueadas.length - 8} más…</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      ) : (
        /* ── Documentos emitidos ─────────────────────────────────────────── */
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {liquidacionesVisibles.length === 0 ? (
            <div className="p-10 text-center text-gray-400 text-sm">
              {filtroContraparte && liquidaciones.length > 0 ? (
                <>
                  {lado === "cliente" ? "Ese cliente" : "Ese proveedor"} no tiene liquidaciones emitidas.
                  <button onClick={() => setFiltroContraparte("")} className="ml-2 underline font-semibold text-gray-500 hover:text-gray-700">
                    Ver las {liquidaciones.length}
                  </button>
                </>
              ) : (
                "Todavía no hay liquidaciones."
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-400 text-[11px] uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Código</th>
                  <th className="text-left px-4 py-2">{lado === "cliente" ? "Cliente / sede" : "Empresa"}</th>
                  <th className="text-left px-4 py-2">Periodo</th>
                  <th className="text-right px-4 py-2">Total</th>
                  <th className="text-left px-4 py-2">Estado</th>
                  <th className="text-left px-4 py-2">Conformidad</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {liquidacionesVisibles.map((l) => {
                  const nombre = lado === "cliente"
                    ? (clientes[l.cliente_id]?.empresa || clientes[l.cliente_id]?.nombre || "—")
                    : (terceros[l.empresa_tercerizada_id]?.razon_social || "—");
                  const sede = sedes.find((s) => s.id === l.cliente_sede_id);
                  const conf = l.conformidad_estado ?? "pendiente";
                  const colorConf = conf === "conforme" ? "bg-emerald-100 text-emerald-700"
                    : conf === "observada" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500";
                  const puedeAprobar = ["borrador", "emitida", "conformada"].includes(l.estado);
                  return (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs">{l.codigo ?? `#${l.id}`}</td>
                      <td className="px-4 py-2">
                        {nombre}
                        {sede && <span className="block text-[11px] text-gray-400">{sede.nombre}</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">{l.periodo ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-bold">{fmtMoneda(Number(l.total ?? 0), l.moneda)}</td>
                      <td className="px-4 py-2">
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-600">{l.estado}</span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${colorConf}`}>{conf}</span>
                        {l.conformidad_por && <span className="block text-[10px] text-gray-400">{l.conformidad_por}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1 justify-end flex-wrap">
                          <button onClick={() => setEditor(l.id)} className="px-2 py-1 rounded-lg text-[11px] font-bold border hover:bg-gray-50">✎ Revisar</button>
                          <button onClick={() => verPdf(l.id)} className="px-2 py-1 rounded-lg text-[11px] font-bold border hover:bg-gray-50">📄 PDF</button>
                          {l.estado !== "borrador" && l.estado !== "anulada" && (
                            <button onClick={() => setEnviar({ ...l, lado })} className="px-2 py-1 rounded-lg text-[11px] font-bold text-white" style={{ background: cp }}>✉ Enviar</button>
                          )}
                          {(l.estado === "emitida" || l.estado === "observada") && (
                            <button onClick={() => reabrir(l)} className="px-2 py-1 rounded-lg text-[11px] font-bold border hover:bg-gray-50">↩ Reabrir</button>
                          )}
                          {puedeAprobar && (
                            <button onClick={() => aprobar(l)} disabled={trabajando}
                              className="px-2 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                              {lado === "cliente" ? "Facturar" : "→ CxP"}
                            </button>
                          )}
                          {l.estado !== "anulada" && !l.factura_id && !l.documento_compra_id && (
                            <button onClick={() => anular(l)} className="px-2 py-1 rounded-lg text-[11px] font-bold border text-red-600 border-red-200 hover:bg-red-50">🗑</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {editor != null && (
        <ModalEditor lado={lado} liquidacionId={editor} usuario={usuario}
          onCerrar={() => setEditor(null)} onCambio={cargarLiquidaciones} onVerPdf={verPdf} />
      )}
      {modalSede && (
        <ModalSede sede={modalSede.sede} clienteNombre={modalSede.cliente}
          onCerrar={() => setModalSede(null)}
          onGuardada={() => { setModalSede(null); cargar(); }} />
      )}
      {enviar && (
        <ModalEnviar liquidacion={enviar} lado={lado}
          sede={sedes.find((s) => s.id === enviar.cliente_sede_id) ?? null}
          contraparte={lado === "cliente" ? clientes[enviar.cliente_id] : terceros[enviar.empresa_tercerizada_id]}
          onCerrar={() => setEnviar(null)}
          onEnviado={() => { setEnviar(null); cargarLiquidaciones(); }} />
      )}
      {modalCostos && (
        <ModalCostos reservas={modalCostos} terceros={terceros} unidadDe={unidadDe}
          onCerrar={() => setModalCostos(null)}
          onGuardado={() => { setModalCostos(null); setMsg("Costos pactados. El bloque rojo se recalcula."); cargar(); }} />
      )}
      {modalPrecios && (
        <ModalPrecios reservas={modalPrecios} unidadDe={unidadDe}
          onCerrar={() => setModalPrecios(null)}
          onGuardado={(n) => {
            setModalPrecios(null);
            setMsg(`✅ Precio cargado en ${n} servicio(s). Sus rutas ya entran a la valorización.`);
            cargar();
          }} />
      )}
      {modalEnlaces && (
        <ModalEnlaces pendientes={modalEnlaces} lado={lado}
          clienteDe={(r) =>
            (r.cliente_id != null
              ? clientes[r.cliente_id]?.empresa || clientes[r.cliente_id]?.nombre
              : null) ?? "Sin cliente"}
          onCerrar={() => setModalEnlaces(null)}
          onGuardado={(n) => {
            setModalEnlaces(null);
            setMsg(`✅ ${n} par(es) enlazado(s). Esos días vuelven a contarse como UN servicio con su ida y su retorno.`);
            cargar();
          }} />
      )}
      {modalServicios && (
        <ModalServicios
          titulo={modalServicios.titulo} subtitulo={modalServicios.subtitulo} lado={lado}
          reservas={modalServicios.ids.map((id) => reservasPorId.get(id)).filter(Boolean) as ReservaLiq[]}
          universo={reservas} catalogo={catalogo} unidadDe={unidadDe} usuario={usuario}
          onCerrar={() => setModalServicios(null)}
          onGuardado={(n, resinc) => {
            setModalServicios(null);
            setMsg(
              `✅ ${n} servicio(s) corregido(s) en su origen.` +
              (resinc ? ` ${resinc} borrador(es) volvieron a derivar sus líneas.` : "") +
              " La valorización del periodo se recalcula."
            );
            cargar();
          }} />
      )}
      {/* Solo del lado cliente. La capacidad contratada y la columna "Precio cliente" son
          de esa cara: en la pestaña del proveedor, `precio_unitario` es el COSTO, y la
          tabla estaría rotulando como precio de venta lo que se le paga al tercero. El
          botón ya está gateado, pero la bandera no se apaga sola al cambiar de pestaña. */}
      {modalRutas && lado === "cliente" && (
        <ModalRutasContratadas rutas={rutasDelPeriodo} catalogoDisponible={rutas.disponible}
          onCerrar={() => setModalRutas(false)}
          /* El detalle se abre ENCIMA y este modal se queda debajo: cerrarlo perdería los
             PAX ya tecleados, y volver a la ficha después de mirar los servicios es
             justamente el motivo por el que se miran. */
          onVerServicios={(r) => verServicios(
            r.nombreIda ?? "(sin nombre de ruta)",
            [
              r.clienteNombre, r.sedeNombre,
              r.nombreRetorno ? `↩ ${r.nombreRetorno}` : "",
              `${r.servicios} día(s) cobrado(s) en el periodo`,
            ].filter(Boolean).join(" · "),
            r.reservasPeriodo
          )}
          onGuardado={(n) => {
            setModalRutas(false);
            setMsg(`✅ ${n} ruta(s) fichada(s). Las liquidaciones nuevas ya imprimen su capacidad contratada.`);
            cargar();
          }} />
      )}
    </div>
  );
}
