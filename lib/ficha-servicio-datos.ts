// lib/ficha-servicio-datos.ts — TODO lo que la ficha de un servicio necesita y el lote diario
// de /seguimiento NO carga. Una sola función, LAZY al abrir el drawer.
//
// Esto NO es un módulo puro (hace red) pero tampoco es un componente: sin React, sin JSX, sin
// estado. Solo trae filas y las deja con la forma exacta que piden los dos motores puros:
//   · lib/servicio-tiempos.ts  → derivarTiempos({ reserva, paradas, abordajes, eventos, gps, … })
//   · lib/documentos-estado.ts → evaluarAptitud({ fechaServicio, unidad, docsUnidad, conductor, empresa })
//
// ── POR QUÉ NADA DE ESTO PUEDE IR AL BATCH DIARIO ─────────────────────────────────────
// `cargar()` (app/seguimiento/page.tsx:1348) trae el día ENTERO: reservas + paradas + abordajes
// + gastos + documentos de todos los proveedores. Lo de aquí es por SERVICIO y con PII fuerte
// (nombre y DNI de cada pasajero, licencia y teléfono del conductor): meterlo en el lote sería
// descargar el roster nominal de 40 servicios para mirar uno. Mismo razonamiento que ya llevó a
// hacer lazy `cargarDocDatos` (page.tsx:1034) y la ventana de datos del portal cliente (6b90b7b).
//
// ── LAS TRES TRAMPAS QUE ESTE ARCHIVO EVITA, Y DE DÓNDE SALIÓ CADA UNA ─────────────────
//
// 1) LA LICENCIA QUE NUNCA SE LEÍA.  app/seguimiento/page.tsx:1081 pide
//    `conductores.select("nombre,numero_licencia")`. Esa columna NO existe: la que el ERP
//    ESCRIBE es `conductores.licencia` (app/conductores/page.tsx:203, dentro del payload de
//    `guardar()`; y el tipo `Conductor` de esa página, :10, declara `licencia: string`). Las
//    pantallas sanas la leen así: app/despachador/page.tsx:346 y app/programacion/page.tsx:1213
//    ambas hacen `select("id,nombre,licencia,…")`.
//    Consecuencia del error: PostgREST no ignora una columna inexistente, DEVUELVE ERROR
//    (42703) y el select entero falla → `data` llega null → `conductor` queda null → el
//    Manifiesto MTC sale sin conductor Y sin licencia también en FLOTA PROPIA, no solo en
//    tercerizados (el aviso ámbar del drawer solo culpa a los terceros: culpa a quien no fue).
//    La huella del bug está a la vista en app/cliente/page.tsx:691-697: pide `numero_licencia`
//    y después lee `data.licencia` — alguien vio el nombre bueno y arregló media línea.
//    Aquí se pide `licencia`, y por si acaso hay un despliegue con el esquema viejo, el fallo
//    del select explícito reintenta con `select("*")` y se acepta `licencia ?? numero_licencia`.
//
// 2) EL GPS DEL SERVICIO DE AL LADO.  Filtrar por vehículo SIN acotar la ventana metía la huella
//    del servicio ANTERIOR del mismo bus (531 puntos sembrando el avance de un servicio que aún
//    no arrancaba — commit 4e2cdf7). La ventana canónica ya existe y NO se reinventa aquí: se
//    copia de app/api/cliente/gps/route.ts:53-58 y :129-140 (MARGEN_PREVIO_MS 45 min,
//    DURACION_MAX_MS 26 h, HUECO_VIAJE_MS 30 min, y el corte por tramos `tramoDelServicio`).
//    Orden de preferencia: puntos atados a `reserva_id` (evidencia dura) → por vehículo DENTRO
//    de la ventana → nada.
//
// 3) EL TOPE DE 1000 FILAS DE POSTGREST.  Nos mordió tres veces (reservas en /programacion,
//    huella GPS, documentos de terceros): `.limit(5000)` NO lo salta. Todo lo que puede pasar de
//    1000 va paginado con orden estable; lo que va con `.limit()` lleva el límite escrito y
//    razonado al lado. Y NO se pagina con ids que venga sabiendo el llamador: `opts.paradaIds`
//    sale de `s.paradas`, que el lote diario llena con un select SIN paginar
//    (app/seguimiento/page.tsx:1368) — o sea, la misma truncación de la que huimos. Ese atajo se
//    usa solo como PISTA para adelantar la ola 1, y luego se reconcilia contra las paradas que
//    este archivo trae paginadas (ver `cargarFichaDatos`, ola 2). Una parada perdida = abordajes
//    perdidos = hora de salida falsa y un manifiesto legal incompleto: una ida y vuelta de más es
//    barata al lado de eso.
//
// ── RESILIENCIA: UNA CONSULTA CAÍDA NO PUEDE VACIAR LA FICHA (NI MENTIR EN SILENCIO) ──
// Cada consulta va AISLADA y con su captura: si una columna no existe en ese entorno, esa pieza
// vuelve vacía (o incompleta) y se anota en `fallos`, pero el resto de la ficha se pinta. El
// roster hereda literalmente la resiliencia de `cargarDocDatos` (page.tsx:1034-1073):
// `select("*")` para que una columna ausente del abordaje no tumbe la lista entera, dedupe por
// `pasajero_id`, y la edad en consulta APARTE porque pedirla en el join vaciaba el manifiesto
// ("Esperados 0").
//
// POR QUÉ ESTE ARCHIVO NO PAGINA CON `paginarFilas` (lib/huella.ts:78) Y TIENE LO SUYO:
// `paginarFilas` hace `if (error) break` y DEVUELVE lo acumulado sin lanzar. Esa semántica
// ("parcial mejor que vacía, callando") es la CORRECTA para la huella del mapa: media estela
// dibujada vale más que ninguna, y nadie dictamina nada a partir de ella. Aquí no: con estas
// filas se dictamina si un servicio OPERÓ. Un `[]` silencioso hace que los motores puros
// —que no pueden distinguir "no hay evidencia" de "no pude leerla"— pinten `no_arranco` en rojo
// sobre un servicio que sí operó, que es EXACTAMENTE el falso positivo que este rediseño existe
// para borrar. Por eso `paginarEstricto` conserva lo bueno (páginas de 1000, corte por página
// corta, techo de filas) pero devuelve `{ filas, error }`: las filas que haya, y el error SIEMPRE.
// Quien las consume se entera. `lib/huella.ts` no se toca: es de uso general en todo el ERP.

import { supabase } from "@/lib/supabase";
import { esAbordado, type DocPasajero } from "@/lib/documentos-servicio";
import { limaMs, type AbordajeTiempos, type EventoViajeTiempos, type ParadaTiempos, type PuntoGpsTiempos } from "@/lib/servicio-tiempos";
import type { ConductorDoc, DocFila, EmpresaDoc } from "@/lib/documentos-estado";

// ══════════════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * Lo que la ficha necesita de la reserva. Estructuralmente compatible con el `Reserva` de
 * app/seguimiento/page.tsx (que se carga con `select("*")`), así que el llamador pasa
 * `s.reserva` tal cual. NO se importa aquel tipo: no está exportado y no vamos a acoplar una
 * librería a un componente.
 */
export type ReservaFicha = {
  id: number;
  tipo?: string | null;
  estado?: string | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
  cliente_id?: number | null;
  vehiculo_id?: number | null;
  conductor_id?: number | null;
  /** solo en servicios tercerizados; el tipo Reserva de /seguimiento no lo declara pero la fila sí lo trae */
  conductor_tercero_id?: number | null;
  empresa_tercerizada_id?: number | null;
  vehiculo_tercero_id?: number | null;
};

/** Conductor para PINTAR (cabecera de la ficha, Manifiesto MTC, botón de llamar). */
export type ConductorFicha = {
  id: number | null;
  nombre: string | null;
  /** `conductores.licencia` / `conductores_tercero.licencia` — ver trampa 1 en la cabecera */
  licencia: string | null;
  vencimiento_licencia: string | null;
  telefono: string | null;
  /** true → viene de `conductores_tercero`: solo hay licencia, no hay SCTR ni exámenes */
  tercerizado: boolean;
};

/** Empresa tercerizada para PINTAR. Columnas verificadas en app/tercerizadas/page.tsx:11-21. */
export type EmpresaFicha = {
  id: number | null;
  razon_social: string | null;
  ruc: string | null;
  telefono: string | null;
  contacto_nombre: string | null;
  contacto_telefono: string | null;
  estado: string | null;
};

export type FichaDatos = {
  /** roster nominal deduplicado por pasajero_id, listo para el Manifiesto MTC y la lista del drawer */
  roster: DocPasajero[];
  /**
   * Filas CRUDAS de `pasajeros_parada` (sin deduplicar) para `derivarTiempos`. Van sin dedupe a
   * propósito: el motor busca el PRIMER `hora_abordaje` del servicio y la fila que el dedupe
   * descarta puede ser justo la que trae esa hora.
   */
  abordajes: AbordajeTiempos[];
  /**
   * Paradas de ESTA reserva CON `hora_llegada`. Se vuelven a pedir aunque el lote diario haga
   * `paradas.select("*")` (page.tsx:1368) por dos razones: (a) el tipo `Parada` del tablero no
   * declara `hora_llegada`, así que nadie puede usarla sin un cast a ciegas; (b) ese select del
   * lote NO está paginado y un día cargado puede pasar del tope de 1000 filas y dejar sin
   * paradas justo al servicio que se abre.
   */
  paradas: ParadaTiempos[];
  conductor: ConductorFicha | null;
  /** el MISMO conductor con la forma que pide `evaluarAptitud` (misma consulta, cero red extra) */
  docsConductor: ConductorDoc | null;
  /** solo en tercerizados */
  empresa: EmpresaFicha | null;
  /** la MISMA empresa con la forma que pide `evaluarAptitud` */
  docsEmpresa: EmpresaDoc | null;
  /**
   * `documentos_vehiculo` de la unidad propia, o `documentos_tercero` de la empresa SIN
   * pre-filtrar por placa: el filtro `vehiculo_id IS NULL OR = unidad.id` lo aplica
   * `evaluarAptitud` (lib/documentos-estado.ts:637), y filtrarlo aquí fuera es donde se olvidó.
   */
  docsUnidad: DocFila[];
  /** `push_eventos_viaje` con evento='salio' de esta reserva (el push "¡tu bus ya salió!") */
  eventos: EventoViajeTiempos[];
  /**
   * MUESTRA representativa del GPS del servicio: primer punto, último punto y último punto con
   * estado='finalizado'. NO es la huella —para dibujar está /api/cliente/gps— y no hace falta
   * que lo sea: `derivarTiempos` solo mira `gps[0]`, `gps[último]` y los 'finalizado'
   * (lib/servicio-tiempos.ts:548,563-569). Traer 30 000 filas para leer tres es lo que hace
   * lento un drawer que se abre cincuenta veces al día.
   */
  gps: PuntoGpsTiempos[];
  /**
   * Cuántos puntos tiene DE VERDAD el servicio en su ventana. Existe porque `derivarTiempos`
   * cuenta `e.gps.length` para el texto de evidencia ("340 puntos GPS") y con la muestra diría
   * "3". LIMITACIÓN ASUMIDA Y DOCUMENTADA: ese texto solo aparece cuando NINGÚN punto sobrevive
   * a la ventana de sanidad del motor (relojes rotos), o sea casi nunca; para el chip del drawer
   * úsese este campo, que es el número exacto.
   *
   * `null` = NO SE PUDO CONTAR (desconocido), y es distinto de `0` = contado y no hay ninguno.
   * Antes, si el conteo fallaba se caía al tamaño de la MUESTRA (≤ 3) y el drawer pintaba
   * "3 puntos GPS" para un servicio con miles: un número inventado con cara de hecho. El chip
   * debe decir "sin dato" ante `null`, nunca "0" ni un número de relleno.
   */
  gpsTotal: number | null;
  /** de dónde salieron los puntos: atados a la reserva, por vehículo dentro de la ventana, o nada */
  gpsVia: "reserva" | "vehiculo" | "ninguna";
  /** true si la rama por vehículo tocó el techo de filas (ver GPS_MAX_FILAS_VEHICULO) */
  gpsTruncado: boolean;
  clienteRuc: string | null;
  esTer: boolean;
  /**
   * Qué piezas no se pudieron cargar. Vacío = ficha completa. El drawer lo usa para decir
   * "faltan datos" en vez de pintar un cero que parezca un hecho: exactamente lo contrario del
   * "CHECK-IN: No iniciado" que este rediseño viene a borrar.
   *
   * ── CONTRATO CON EL COMPONENTE (components/seguimiento/FichaServicio.tsx) ────────────
   * Nombres posibles, sin más:
   *   "paradas"     · paradas de la reserva y sus `hora_llegada`   ← EVIDENCIA
   *   "abordajes"   · filas de `pasajeros_parada` (horas de abordaje) ← EVIDENCIA
   *   "gps"         · cualquiera de los tiros del rastro GPS        ← EVIDENCIA
   *   "eventos"     · `push_eventos_viaje` ("¡tu bus ya salió!")    ← EVIDENCIA
   *   "roster"      · la lista nominal de pasajeros (sale de `pasajeros_parada` + `pasajeros`)
   *   "conductor"   · fila de conductores / conductores_tercero
   *   "empresa"     · fila de empresas_tercerizadas
   *   "docs_unidad" · documentos_vehiculo / documentos_tercero
   *   "cliente"     · RUC del cliente
   *   "edad"        · edad de los pasajeros (solo adorna el manifiesto)
   * Si `pasajeros_parada` falla se anotan LAS DOS que dependen de ella: "abordajes" y "roster".
   *
   * REGLA DURA: si `fallos` contiene alguna de las cuatro marcadas EVIDENCIA, el drawer NO PUEDE
   * afirmar que el servicio no arrancó — el veredicto rojo se degrada a gris ("sin dato"). Este
   * archivo garantiza su mitad del trato: `fallos` se llena SIEMPRE que una lectura falla,
   * incluidas las paginadas (por eso `paginarEstricto`, ver cabecera).
   */
  fallos: string[];
};

export type OpcionesFicha = {
  /**
   * PISTA (no fuente de verdad): ids de parada que el llamador ya cree conocer (`s.paradas`).
   * Sirve para adelantar los abordajes a la ola 1 en vez de esperar a las paradas.
   *
   * NO se le hace caso a ciegas. Ese array lo llena el lote diario con un select SIN paginar
   * (app/seguimiento/page.tsx:1368): si el día pasa de 1000 filas de `paradas`, las paradas de
   * este servicio pueden venir PARTIDAS, y los abordajes de los paraderos cortados no se pedirían
   * nunca → pasajeros que sí subieron salen "Pendiente", el drawer dice "Abordaron 8 de 20" con
   * 20 abordados y el Manifiesto MTC (documento legal) se imprime con ese roster.
   * Por eso, cuando vuelven las paradas de verdad (paginadas, ola 1), la pista se RECONCILIA:
   * se descartan los ids ajenos y se piden los que faltaban. Cuesta una ida y vuelta extra solo
   * cuando la pista estaba mal; el resto de las veces sale gratis.
   */
  paradaIds?: number[] | null;
  /** ahora en epoch ms (inyectable para pruebas) */
  ahoraMs?: number;
};

// ══════════════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════════════════════════════════════════════

// ── Ventana del servicio. VERBATIM de app/api/cliente/gps/route.ts:53-58. Si allá cambian,
//    aquí también: son el mismo hecho ("¿qué puntos son de ESTE viaje?") contado dos veces.
/** cuánto ANTES de la hora pactada cuenta el GPS (traslado cochera → primer paradero) */
const MARGEN_PREVIO_MS = 45 * 60 * 1000;
/** techo de la ventana: 26 h y no 12 — hay tours full day de hasta 24 h */
const DURACION_MAX_MS = 26 * 60 * 60 * 1000;
/** hueco que separa dos viajes del mismo bus (dentro de un servicio el conductor late cada ~25 s) */
const HUECO_VIAJE_MS = 30 * 60 * 1000;
// NO existe aquí el fallback de "últimas 12 h" del endpoint canónico (route.ts:139). Allá dibuja
// un mapa; aquí se FECHA un servicio, y una ventana que termina en `ahora` fecharía una reserva
// vieja con el GPS de HOY de ese bus — el bug del commit 4e2cdf7 entrando por la puerta de atrás.
// Sin fecha de servicio no hay ventana honesta: no se consulta y se anota el fallo.

/**
 * Techo de filas de la rama por vehículo. 12 000 ≈ 26 h a 8 s/fix, holgado para la cadencia real
 * (~25 s ⇒ ~3 700 puntos en un full day) y 12 páginas en el peor caso. Se necesitan TODAS para
 * cortar por huecos (`tramoDelServicio`): quedarse con las primeras 1000 fecharía el cierre en la
 * primera hora del viaje. Si el techo se alcanza, se marca `gpsTruncado` y el último punto y el
 * cierre se releen con una consulta descendente, para no inventar un fin en la fila 12 000.
 */
const GPS_MAX_FILAS_VEHICULO = 12000;

/** Columnas mínimas del GPS para fechar el servicio: posición y precisión no hacen falta aquí. */
const GPS_COLS = "id,created_at,estado";

/**
 * Tamaño de trozo para los `.in(...)`. Una lista de miles de ids hace que PostgREST responda 400
 * por URL demasiado larga (el bug que dejaba el Historial del portal en bucle infinito, 6b90b7b).
 */
const TROZO_IN = 300;

// ══════════════════════════════════════════════════════════════════════════════════════
// HELPERS DE RED — nada aquí puede lanzar hacia arriba
// ══════════════════════════════════════════════════════════════════════════════════════

/** Una consulta que devuelve filas. Ante cualquier fallo: [] y una anotación en `fallos`. */
async function filas(etiqueta: string, fallos: string[], q: () => PromiseLike<any>): Promise<any[]> {
  try {
    const r: any = await q();
    if (r?.error) { fallos.push(etiqueta); return []; }
    return (r?.data as any[]) || [];
  } catch { fallos.push(etiqueta); return []; }
}

/** Una consulta que devuelve UNA fila (o null). Mismo contrato de fallo. */
async function fila(etiqueta: string, fallos: string[], q: () => PromiseLike<any>): Promise<any | null> {
  try {
    const r: any = await q();
    if (r?.error) { fallos.push(etiqueta); return null; }
    return (r?.data as any) ?? null;
  } catch { fallos.push(etiqueta); return null; }
}

/**
 * Fila única con REINTENTO tolerante: primero la proyección explícita (documenta qué se lee y no
 * arrastra PII de más) y, si falla —típicamente porque una columna no existe en ese despliegue—,
 * `select("*")`. Es el patrón de lib/retrasos-datos.ts:116-126 y la red de seguridad de la
 * trampa 1 de la cabecera: aquí es preferible traer la fila entera que quedarse sin conductor.
 */
async function filaTolerante(
  etiqueta: string, fallos: string[], tabla: string, cols: string, id: number,
): Promise<any | null> {
  try {
    const r: any = await supabase.from(tabla).select(cols).eq("id", id).maybeSingle();
    if (!r?.error) return (r?.data as any) ?? null;
  } catch { /* cae al reintento */ }
  try {
    const r2: any = await supabase.from(tabla).select("*").eq("id", id).maybeSingle();
    if (r2?.error) { fallos.push(etiqueta); return null; }
    return (r2?.data as any) ?? null;
  } catch { fallos.push(etiqueta); return null; }
}

/**
 * Paginación propia con el ERROR A LA VISTA. Misma mecánica que `paginarFilas` (lib/huella.ts:78):
 * páginas de 1000 —el max-rows de Supabase, que `.limit(5000)` NO salta—, corte en cuanto una
 * página llega corta, techo de filas como red de sanidad y `armar()` devolviendo una consulta
 * NUEVA con orden estable para que las páginas no se solapen ni salten filas.
 *
 * LA ÚNICA DIFERENCIA, Y ES LA QUE IMPORTA: `paginarFilas` hace `if (error) break` y devuelve lo
 * acumulado SIN LANZAR, porque supabase-js tampoco lanza ante un error de PostgREST (un 42703 por
 * columna inexistente vuelve como `{ data: null, error }`). Para la huella del mapa eso está bien
 * —media estela vale más que ninguna—. Para la ficha no: de estas filas sale el veredicto de si el
 * servicio operó, y un `[]` mudo se lee como "no hay evidencia" en vez de "no pude leerla". Aquí
 * el error VIAJE ARRIBA siempre; las filas que hubiese se devuelven igual (el drawer avisa
 * "parcial"), pero nadie puede dictaminar nada sin enterarse de que hubo un fallo.
 */
async function paginarEstricto(armar: () => any, max: number): Promise<{ filas: any[]; error: any }> {
  const PAG = 1000;
  const todas: any[] = [];
  for (let desde = 0; desde < max; desde += PAG) {
    let r: any;
    try {
      r = await armar().range(desde, desde + PAG - 1);
    } catch (e) {
      return { filas: todas, error: e ?? new Error("excepción de red") };
    }
    if (r?.error) return { filas: todas, error: r.error };   // ← lo que lib/huella.ts se traga
    const data: any[] = (r?.data as any[]) || [];
    todas.push(...data);
    if (data.length < PAG) break;                            // página corta = no hay más filas
  }
  return { filas: todas, error: null };
}

/** Consulta paginada. Ante cualquier fallo: lo que se alcanzó a leer + anotación en `fallos`. */
async function filasPaginadas(
  etiqueta: string, fallos: string[], armar: () => any, max = 20000,
): Promise<any[]> {
  const { filas: fs, error } = await paginarEstricto(armar, max);
  if (error) fallos.push(etiqueta);
  return fs;
}

/** Conteo exacto sin traer filas. null si no se pudo contar. */
async function contar(etiqueta: string, fallos: string[], armar: () => any): Promise<number | null> {
  try {
    const r: any = await armar();
    if (r?.error) { fallos.push(etiqueta); return null; }
    return typeof r?.count === "number" ? r.count : null;
  } catch { fallos.push(etiqueta); return null; }
}

/** Parte una lista de ids en trozos para no reventar la URL del `.in(...)`. */
function trozos<T>(xs: T[], n = TROZO_IN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// GPS — ventana canónica, no una inventada
// ══════════════════════════════════════════════════════════════════════════════════════

/** epoch ms de una fila de GPS. `created_at` es la columna fiable (la pone el insert del conductor). */
const msDe = (g: any): number => {
  const t = g?.created_at ? Date.parse(g.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * Corte por tramos contiguos y elección del tramo DEL SERVICIO. Copia fiel de
 * app/api/cliente/gps/route.ts:80-92: un hueco > `gapMs` significa que la app dejó de transmitir,
 * o sea otro viaje. Se elige el primer tramo que seguía vivo a la hora programada (`refTs`);
 * "quedarse con el último" solo acierta cuando el servicio consultado es el de ahora mismo, y al
 * abrir uno de ayer devolvía el viaje de hoy.
 */
function tramoDelServicio(filasGps: any[], gapMs: number, refTs: number | null): any[] {
  if (filasGps.length < 2) return filasGps;
  const tramos: any[][] = [];
  let ini = 0;
  for (let i = 1; i < filasGps.length; i++) {
    if (msDe(filasGps[i]) - msDe(filasGps[i - 1]) > gapMs) { tramos.push(filasGps.slice(ini, i)); ini = i; }
  }
  tramos.push(filasGps.slice(ini));
  const ultimo = tramos[tramos.length - 1];
  if (refTs == null) return ultimo;                       // sin hora pactada no hay con qué anclar
  return tramos.find((t) => msDe(t[t.length - 1]) >= refTs) ?? ultimo;
}

/**
 * Comprime una serie a lo que `derivarTiempos` realmente consume: primer punto (inicio estimado),
 * último 'finalizado' (cierre del conductor — la app FUERZA ese fix al pulsar finalizar) y último
 * punto (última señal). Ordenados asc y sin repetir fila.
 */
function muestraGps(filasGps: any[], extra: any[] = []): PuntoGpsTiempos[] {
  const vivas = [...filasGps, ...extra].filter((g) => g && msDe(g) > 0);
  if (!vivas.length) return [];
  const orden = vivas.slice().sort((a, b) => msDe(a) - msDe(b));
  const finalizados = orden.filter((g) => String(g.estado ?? "") === "finalizado");
  const elegidas = [orden[0], finalizados[finalizados.length - 1], orden[orden.length - 1]].filter(Boolean);
  const vistas = new Set<string>();
  const out: PuntoGpsTiempos[] = [];
  for (const g of elegidas) {
    const clave = g.id != null ? `i${g.id}` : `t${g.created_at}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    out.push({ created_at: g.created_at ?? null, estado: g.estado ?? null });
  }
  return out.sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)));
}

async function cargarGps(
  r: ReservaFicha, ahoraMs: number, fallos: string[],
): Promise<{ gps: PuntoGpsTiempos[]; gpsTotal: number | null; gpsVia: FichaDatos["gpsVia"]; gpsTruncado: boolean }> {
  // Marca para saber si ALGUNA lectura de GPS falló durante esta función. Si falló, "no hay
  // puntos" es indistinguible de "no pude mirar": entonces `gpsTotal` vale null (desconocido),
  // nunca 0 — un 0 aquí es la semilla del falso "no arrancó".
  // Se pregunta por la ETIQUETA, no por la longitud del array. `fallos` es compartido y las demás
  // piezas de la ola 1 corren en paralelo (Promise.all): comparar longitudes hacía que el fallo de
  // otra consulta cualquiera —el roster, por ejemplo— se leyera aquí como "falló el GPS", y al revés
  // dejaba la invariante de abajo sin cumplirse. Todas las anotaciones de esta función usan "gps".
  const huboFallo = () => fallos.includes("gps");
  const vacio = () => ({
    gps: [] as PuntoGpsTiempos[],
    gpsTotal: huboFallo() ? null : 0,
    gpsVia: "ninguna" as const,
    gpsTruncado: false,
  });

  // ── RAMA 1: puntos ATADOS A LA RESERVA. Evidencia dura: la app del conductor ata cada fix al
  // servicio al iniciar el recorrido, así que aquí no hay riesgo de mezclar viajes y no hace
  // falta ni ventana ni corte por huecos. Tres consultas de UNA fila + un conteo: el coste no
  // depende de la duración del servicio.
  const desc = { ascending: false };
  const [primero, ultimo, finalizado, total] = await Promise.all([
    filas("gps", fallos, () => supabase.from("ubicaciones_gps").select(GPS_COLS)
      .eq("reserva_id", r.id).order("created_at", { ascending: true }).limit(1)),
    filas("gps", fallos, () => supabase.from("ubicaciones_gps").select(GPS_COLS)
      .eq("reserva_id", r.id).order("created_at", desc).limit(1)),
    filas("gps", fallos, () => supabase.from("ubicaciones_gps").select(GPS_COLS)
      .eq("reserva_id", r.id).eq("estado", "finalizado").order("created_at", desc).limit(1)),
    contar("gps", fallos, () => supabase.from("ubicaciones_gps")
      .select("id", { count: "exact", head: true }).eq("reserva_id", r.id)),
  ]);

  const porReserva = [...primero, ...ultimo, ...finalizado];
  if (porReserva.length) {
    // INVARIANTE que el componente puede dar por buena: `gpsTotal === null` ⇒ "gps" ∈ fallos.
    // Un conteo que vuelve sin número (sin error) también es un desconocido: se anota igual.
    if (total == null && !huboFallo()) fallos.push("gps");
    return {
      // `total` es el conteo exacto. Si `contar()` falló vale null y así se propaga: caer a
      // `porReserva.length` diría "3 puntos GPS" (el tamaño de la MUESTRA) para un servicio con
      // miles. Mejor un hueco declarado que un número inventado.
      gps: muestraGps(porReserva),
      gpsTotal: total,
      gpsVia: "reserva",
      gpsTruncado: false,
    };
  }

  // ── RAMA 2: por VEHÍCULO, y SIEMPRE dentro de la ventana del servicio. Sin esta cota se traían
  // "las últimas 12 h del bus": el traslado desde cochera, el modo conectado-libre (que manda
  // reserva_id null) y el servicio anterior si la separación fue < 30 min (commit 4e2cdf7).
  const esTer = r.tipo === "tercerizada";
  const vehiculoId = esTer ? null : r.vehiculo_id ?? null;
  const vehiculoTerceroId = esTer ? r.vehiculo_tercero_id ?? null : null;
  if (vehiculoId == null && vehiculoTerceroId == null) return vacio();

  // ── LA VENTANA SIEMPRE TIENE TECHO ───────────────────────────────────────────────────
  // `limaMs(fecha, null)` ancla a las 00:00 de Lima del día del servicio, así que una reserva sin
  // `hora_servicio` queda acotada al DÍA + el margen canónico de 26 h (DURACION_MAX_MS), que es
  // justo lo que cubre un full day que se pasa de medianoche. Lo que NO puede pasar nunca es
  // quedarse sin `.lte`: sin techo, `tramoDelServicio` se queda con el ÚLTIMO tramo del bus y el
  // drawer fecharía una reserva de hace meses con el GPS de HOY (bug del commit 4e2cdf7).
  const progMs = limaMs(r.fecha_servicio, r.hora_servicio);
  if (progMs == null) {
    // Sin fecha de servicio no hay ventana que anclar. Antes que fechar el servicio con el viaje
    // de otro día, un hueco honesto: se anota "gps" y el drawer sabe que no puede concluir nada.
    fallos.push("gps");
    return vacio();
  }
  // Evidencia dura de inicio, en el mismo orden que el endpoint canónico: puntos atados a la
  // reserva (no hay, si llegamos aquí) → estado puesto por una persona.
  const estado = String(r.estado ?? "");
  const iniciado = estado === "en_curso" || estado === "finalizada";
  // Con el inicio confirmado la ventana se abre 45 min antes (ese traslado SÍ es del servicio).
  // Sin confirmar, abre en la hora pactada EXACTA: antes de esa hora nadie puede afirmar que el
  // bus se mueve por este servicio.
  const T0 = progMs - (iniciado ? MARGEN_PREVIO_MS : 0);
  const T1 = T0 + DURACION_MAX_MS;
  if (ahoraMs < T0) return vacio();   // todavía no empieza la ventana: no hay nada que pedir

  const desdeIso = new Date(T0).toISOString();
  const hastaIso = new Date(Math.min(T1, ahoraMs)).toISOString();
  const armar = () =>
    (vehiculoTerceroId != null
      ? supabase.from("ubicaciones_gps").select(GPS_COLS).eq("vehiculo_tercero_id", vehiculoTerceroId)
      : supabase.from("ubicaciones_gps").select(GPS_COLS).eq("vehiculo_id", vehiculoId))
      .gte("created_at", desdeIso)
      .lte("created_at", hastaIso)
      .order("created_at", { ascending: true }).order("id", { ascending: true });
  const marcaAntesDeLeer = fallos.length;
  const crudas = await filasPaginadas("gps", fallos, armar, GPS_MAX_FILAS_VEHICULO);
  const lecturaIncompleta = fallos.length > marcaAntesDeLeer;
  if (!crudas.length) return vacio();

  const truncado = crudas.length >= GPS_MAX_FILAS_VEHICULO;
  // La ventana todavía puede contener DOS viajes del mismo bus (un full day con relevo): el corte
  // por huecos se queda con el que corresponde a la hora programada.
  const tramo = tramoDelServicio(crudas, HUECO_VIAJE_MS, progMs);

  // Si tocamos el techo, el "último" que tenemos es la fila 12 000, no el final del viaje: se
  // relee de la BD para no fechar el cierre en mitad del recorrido.
  let extra: any[] = [];
  if (truncado) {
    const enVentana = () =>
      (vehiculoTerceroId != null
        ? supabase.from("ubicaciones_gps").select(GPS_COLS).eq("vehiculo_tercero_id", vehiculoTerceroId)
        : supabase.from("ubicaciones_gps").select(GPS_COLS).eq("vehiculo_id", vehiculoId))
        .gte("created_at", desdeIso).lte("created_at", hastaIso);
    const cola = () => enVentana().order("created_at", desc).limit(1);
    const colaFin = () => enVentana().eq("estado", "finalizado").order("created_at", desc).limit(1);
    const [u, f] = await Promise.all([
      filas("gps", fallos, cola),
      filas("gps", fallos, colaFin),
    ]);
    extra = [...u, ...f];
  }

  return {
    gps: muestraGps(tramo, extra),
    // Si la paginación se cortó por un error, `tramo.length` es una cota inferior de origen
    // desconocido: no se pinta como si fuera el número de puntos del servicio.
    gpsTotal: lecturaIncompleta ? null : tramo.length,
    gpsVia: "vehiculo",
    gpsTruncado: truncado,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// ROSTER — herencia literal de cargarDocDatos (app/seguimiento/page.tsx:1034-1073)
// ══════════════════════════════════════════════════════════════════════════════════════

async function cargarAbordajes(paradaIds: number[], fallos: string[]): Promise<any[]> {
  if (!paradaIds.length) return [];
  const out: any[] = [];
  for (const trozo of trozos(paradaIds)) {
    // select("*, …") como en el portal cliente: NO nombrar las columnas del abordaje evita que
    // una columna ausente en algún entorno tumbe TODO el select y vacíe el roster.
    // Paginado + orden estable: un servicio con muchos paraderos y roster grande puede pasar del
    // tope de 1000 filas de PostgREST.
    const { filas: parte, error } = await paginarEstricto(() =>
      supabase.from("pasajeros_parada").select("*, pasajero:pasajeros(nombre,dni)")
        .in("parada_id", trozo)
        .order("parada_id", { ascending: true }).order("pasajero_id", { ascending: true }), 20000);
    // Una sola tabla, DOS piezas del contrato: de `pasajeros_parada` salen las horas de abordaje
    // (evidencia para el veredicto) y la lista nominal del manifiesto. Si falla, las dos quedan
    // en duda y las dos se anotan.
    if (error) fallos.push("abordajes", "roster");
    out.push(...parte);
  }
  return out;
}

/**
 * Reconcilia la PISTA `opts.paradaIds` con las paradas que este archivo trajo paginadas.
 * La pista viene de un select sin paginar del lote diario: puede estar CORTADA (faltarían
 * abordajes → pasajeros "Pendiente" que sí subieron) o traer ids que ya no son de esta reserva.
 * Se descarta lo ajeno y se piden solo los paraderos que la pista no cubría: la ida y vuelta
 * extra ocurre únicamente cuando la pista estaba mal.
 */
async function conciliarAbordajes(
  pre: any[] | null, pista: number[], reales: number[], paradasIlegibles: boolean, fallos: string[],
): Promise<any[]> {
  if (pre == null) return cargarAbordajes(reales, fallos);        // no hubo atajo: camino normal
  // Si las paradas no se pudieron leer, `reales` no es fuente de verdad de nada: lo único que
  // hay es la pista, y tirarla dejaría la ficha sin abordajes por partida doble. Ya está anotado
  // el fallo "paradas", que es lo que frena cualquier veredicto.
  if (paradasIlegibles) return pre;
  const setReales = new Set(reales);
  const setPista = new Set(pista);
  const limpio = pre.filter((x) => x?.parada_id == null || setReales.has(Number(x.parada_id)));
  const faltantes = reales.filter((id) => !setPista.has(id));
  if (!faltantes.length) return limpio;
  return [...limpio, ...await cargarAbordajes(faltantes, fallos)];
}

/** Edad para el Manifiesto MTC. Consulta AISLADA: si la columna no existe falla sola y el
 *  manifiesto muestra "–" en vez de quedarse sin roster (bug "Esperados 0"). */
async function pegarEdades(roster: DocPasajero[], fallos: string[]): Promise<void> {
  const ids = [...new Set(roster.map((x) => x.pasajero_id).filter(Boolean))] as number[];
  if (!ids.length) return;
  const mapa = new Map<number, number | null>();
  for (const trozo of trozos(ids)) {
    const rows = await filas("edad", fallos, () => supabase.from("pasajeros").select("id,edad").in("id", trozo));
    for (const e of rows) mapa.set(e.id, e.edad ?? null);
  }
  if (!mapa.size) return;
  roster.forEach((x) => { if (x.pasajero) (x.pasajero as any).edad = mapa.get(x.pasajero_id) ?? null; });
}

// ══════════════════════════════════════════════════════════════════════════════════════
// ENTRADA ÚNICA
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * Trae, en dos olas de red paralelas, todo lo que la ficha del servicio necesita.
 *
 * Uso típico desde el drawer:
 *
 *   const d = await cargarFichaDatos(s.reserva, { paradaIds: s.paradas.map(p => p.id) });
 *
 *   const t = derivarTiempos({
 *     reserva: s.reserva, paradas: d.paradas, abordajes: d.abordajes,
 *     eventos: d.eventos, gps: d.gps, ahoraMs: Date.now(),
 *   });
 *
 *   const apt = evaluarAptitud({
 *     fechaServicio: s.reserva.fecha_servicio!,
 *     // la placa la tiene el tablero (s.vehiculo_placa); el id, la reserva
 *     unidad: { id: d.esTer ? s.reserva.vehiculo_tercero_id! : s.reserva.vehiculo_id!,
 *               placa: s.vehiculo_placa, tercerizada: d.esTer },
 *     docsUnidad: d.docsUnidad, conductor: d.docsConductor, empresa: d.docsEmpresa,
 *   });
 *
 * Nunca lanza: lo que no se pudo traer viene vacío (o incompleto) y SIEMPRE anotado en `fallos`
 * — incluidas las lecturas paginadas, que es donde el error se perdía. Ver el contrato de
 * `fallos` en el tipo `FichaDatos`: si contiene "paradas", "abordajes", "gps" o "eventos", el
 * drawer no puede afirmar que el servicio no arrancó.
 */
export async function cargarFichaDatos(r: ReservaFicha, opts?: OpcionesFicha): Promise<FichaDatos> {
  const fallos: string[] = [];
  const ahoraMs = Number.isFinite(Number(opts?.ahoraMs)) ? Number(opts!.ahoraMs) : Date.now();
  const esTer = r.tipo === "tercerizada";
  const condId = esTer ? (r.conductor_tercero_id ?? null) : (r.conductor_id ?? null);

  // ── OLA 1 ────────────────────────────────────────────────────────────────────────────
  // Todo lo que no depende de otra consulta. Si el llamador ya sabe los ids de parada, los
  // abordajes entran también en esta ola en vez de esperar a que vuelvan las paradas.
  const paradaIdsPrevios = (opts?.paradaIds || []).filter((x) => x != null);

  const [
    paradasRaw, condRow, empRow, docsUnidad, eventos, cliRow, datosGps, abordajesPre,
  ] = await Promise.all([
    // Paradas CON hora_llegada (la hora real de arribo que escribe el geocerco del conductor —
    // app/api/conductor/route.ts:454-460). Es la evidencia que hoy nadie enseña.
    filasPaginadas("paradas", fallos, () =>
      supabase.from("paradas").select("id,reserva_id,orden,nombre,estado,hora_estimada,hora_llegada")
        .eq("reserva_id", r.id)
        .order("orden", { ascending: true }).order("id", { ascending: true }), 5000),

    // Conductor: `licencia` (NO `numero_licencia` — ver trampa 1). Tolerante: si el select
    // explícito falla, reintenta con `select("*")`.
    condId == null
      ? Promise.resolve(null)
      : esTer
        ? filaTolerante("conductor", fallos, "conductores_tercero",
            "id,nombre,licencia,vencimiento_licencia,telefono", condId)
        : filaTolerante("conductor", fallos, "conductores",
            "id,nombre,licencia,telefono,vencimiento_licencia,sctr_salud_venc,sctr_pension_venc,examen_medico_venc,psicosometrico_venc,fecha_venc_contrato",
            condId),

    // Empresa tercerizada: razón social + habilitaciones propias (columnas verificadas en
    // app/tercerizadas/page.tsx:11-21).
    esTer && r.empresa_tercerizada_id != null
      ? filaTolerante("empresa", fallos, "empresas_tercerizadas",
          "id,razon_social,ruc,telefono,contacto_nombre,contacto_telefono,estado,venc_autorizacion,venc_habilitacion",
          r.empresa_tercerizada_id)
      : Promise.resolve(null),

    // Documentos de la unidad. Se trae `vehiculo_id` SIEMPRE: en `documentos_tercero` NULL
    // significa "documento general de la empresa" y con valor "de esa placa"; sin esa columna, el
    // SOAT vencido de la unidad B bloquea a la unidad A (PROBLEMA 3 de lib/documentos-estado.ts).
    esTer
      ? (r.empresa_tercerizada_id == null ? Promise.resolve([]) : filasPaginadas("docs_unidad", fallos, () =>
          supabase.from("documentos_tercero").select("id,empresa_id,vehiculo_id,tipo,fecha_vencimiento")
            .eq("empresa_id", r.empresa_tercerizada_id)
            .order("fecha_vencimiento", { ascending: true }).order("id", { ascending: true }), 5000))
      : (r.vehiculo_id == null ? Promise.resolve([]) : filasPaginadas("docs_unidad", fallos, () =>
          supabase.from("documentos_vehiculo").select("id,vehiculo_id,tipo,fecha_vencimiento")
            .eq("vehiculo_id", r.vehiculo_id)
            .order("fecha_vencimiento", { ascending: true }).order("id", { ascending: true }), 5000)),

    // Aviso "¡tu bus ya salió!". El índice único de dedupe (supabase/push-notificaciones.sql:67)
    // garantiza como mucho una fila por reserva; el .limit(20) es cinturón, no cota real.
    filas("eventos", fallos, () =>
      supabase.from("push_eventos_viaje").select("evento,enviado_en")
        .eq("reserva_id", r.id).eq("evento", "salio")
        .order("enviado_en", { ascending: true }).limit(20)),

    // RUC del cliente para la cabecera fiscal del reporte.
    r.cliente_id == null
      ? Promise.resolve(null)
      : fila("cliente", fallos, () => supabase.from("clientes").select("ruc").eq("id", r.cliente_id).maybeSingle()),

    cargarGps(r, ahoraMs, fallos),

    paradaIdsPrevios.length ? cargarAbordajes(paradaIdsPrevios as number[], fallos) : Promise.resolve(null),
  ]);

  const paradas: ParadaTiempos[] = (paradasRaw as any[]).map((p) => ({
    id: Number(p.id), orden: p.orden ?? null, nombre: p.nombre ?? null,
    estado: p.estado ?? null, hora_estimada: p.hora_estimada ?? null, hora_llegada: p.hora_llegada ?? null,
  }));

  // ── OLA 2 ────────────────────────────────────────────────────────────────────────────
  // `paradas` (paginadas, recién leídas) es la ÚNICA fuente de verdad de qué paraderos tiene el
  // servicio; `paradaIdsPrevios` era solo la pista para adelantar la ola 1.
  const paradaIds = paradas.map((p) => p.id);
  const paradasIlegibles = fallos.includes("paradas");
  const [ppRaw, paxAdhoc] = await Promise.all([
    conciliarAbordajes(abordajesPre as any[] | null, paradaIdsPrevios as number[], paradaIds, paradasIlegibles, fallos),
    // Pasajeros sin paradero: existen en `pasajeros.reserva_id` pero sin fila en
    // `pasajeros_parada`. Sin ellos el manifiesto cuenta de menos.
    filasPaginadas("roster", fallos, () =>
      supabase.from("pasajeros").select("id,nombre,dni").eq("reserva_id", r.id).order("id", { ascending: true }), 5000),
  ]);

  // Deduplicar por pasajero_id: un pasajero puede tener fila en 2+ paradas de la misma reserva y
  // el manifiesto legal (N° de asiento) no debe listarlo dos veces. Se conserva preferentemente la
  // fila ABORDADA. (Copiado de cargarDocDatos, app/seguimiento/page.tsx:1050-1057.)
  const porPax = new Map<number, any>();
  for (const x of ppRaw as any[]) {
    const prev = porPax.get(x.pasajero_id);
    if (!prev || (!esAbordado(prev) && esAbordado(x))) porPax.set(x.pasajero_id, x);
  }
  const pp = [...porPax.values()];
  const asignados = new Set(pp.map((x) => x.pasajero_id));
  const sinParada = (paxAdhoc as any[])
    .filter((p) => !asignados.has(p.id))
    .map((p) => ({
      parada_id: null, pasajero_id: p.id, estado: "Pendiente", estado_abordaje: null,
      hora_abordaje: null, pasajero: { nombre: p.nombre, dni: p.dni },
    }));
  const roster: DocPasajero[] = [...pp, ...sinParada];
  await pegarEdades(roster, fallos);

  // ── Conductor: una fila, dos formas ──────────────────────────────────────────────────
  // `licencia ?? numero_licencia`: la buena es `licencia` (verificada contra el código que
  // ESCRIBE, app/conductores/page.tsx:203). El segundo nombre solo se acepta por si el reintento
  // con `select("*")` cayó en un esquema donde exista; nunca se PIDE por su nombre.
  const conductor: ConductorFicha | null = condRow
    ? {
        id: (condRow as any).id ?? condId,
        nombre: (condRow as any).nombre ?? null,
        licencia: (condRow as any).licencia ?? (condRow as any).numero_licencia ?? null,
        vencimiento_licencia: (condRow as any).vencimiento_licencia ?? null,
        telefono: (condRow as any).telefono ?? null,
        tercerizado: esTer,
      }
    : null;

  // Forma para `evaluarAptitud`. A un conductor TERCERIZADO solo se le puede exigir la licencia:
  // `conductores_tercero` no tiene sctr_*_venc ni exámenes (HUECO CONOCIDO documentado en
  // lib/documentos-estado.ts:188-199). Por eso los campos de flota propia van solo si !esTer.
  const docsConductor: ConductorDoc | null = condRow
    ? {
        id: conductor!.id,
        nombre: conductor!.nombre,
        tercerizado: esTer,
        vencimiento_licencia: conductor!.vencimiento_licencia,
        ...(esTer ? {} : {
          sctr_salud_venc: (condRow as any).sctr_salud_venc ?? null,
          sctr_pension_venc: (condRow as any).sctr_pension_venc ?? null,
          examen_medico_venc: (condRow as any).examen_medico_venc ?? null,
          psicosometrico_venc: (condRow as any).psicosometrico_venc ?? null,
          fecha_venc_contrato: (condRow as any).fecha_venc_contrato ?? null,
        }),
      }
    : null;

  const empresa: EmpresaFicha | null = empRow
    ? {
        id: (empRow as any).id ?? r.empresa_tercerizada_id ?? null,
        razon_social: (empRow as any).razon_social ?? null,
        ruc: (empRow as any).ruc ?? null,
        telefono: (empRow as any).telefono ?? null,
        contacto_nombre: (empRow as any).contacto_nombre ?? null,
        contacto_telefono: (empRow as any).contacto_telefono ?? null,
        estado: (empRow as any).estado ?? null,
      }
    : null;

  const docsEmpresa: EmpresaDoc | null = empRow
    ? {
        id: empresa!.id,
        razon_social: empresa!.razon_social,
        estado: empresa!.estado,
        venc_autorizacion: (empRow as any).venc_autorizacion ?? null,
        venc_habilitacion: (empRow as any).venc_habilitacion ?? null,
      }
    : null;

  const abordajes: AbordajeTiempos[] = (ppRaw as any[]).map((x) => ({
    parada_id: x.parada_id ?? null,
    pasajero_id: x.pasajero_id ?? null,
    hora_abordaje: x.hora_abordaje ?? null,
  }));

  return {
    roster,
    abordajes,
    paradas,
    conductor,
    docsConductor,
    empresa,
    docsEmpresa,
    docsUnidad: docsUnidad as DocFila[],
    eventos: (eventos as any[]).map((e) => ({ evento: e.evento ?? null, enviado_en: e.enviado_en ?? null })) as EventoViajeTiempos[],
    gps: datosGps.gps,
    gpsTotal: datosGps.gpsTotal,
    gpsVia: datosGps.gpsVia,
    gpsTruncado: datosGps.gpsTruncado,
    clienteRuc: (cliRow as any)?.ruc ?? null,
    esTer,
    // Se deduplica: una pieza que reintenta varias veces (los cuatro tiros del GPS) no debe
    // aparecer cuatro veces en el aviso al operador.
    fallos: [...new Set(fallos)],
  };
}
