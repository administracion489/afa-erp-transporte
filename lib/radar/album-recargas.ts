// lib/radar/album-recargas.ts — Cuántos DESPACHOS trae un álbum de fotos, no cuántas fotos.
// Módulo PURO (no toca la base ni secretos), como coherencia-voucher.ts e identidad-voucher.ts.
// Lo consume lib/radar/acciones.ts y lo prueba scripts/prueba-album-recargas.mts.
//
// EL PROBLEMA. El motor agrupa los mensajes de un mismo remitente en el mismo grupo dentro de
// ±10 min (`resolverCluster`) porque un reporte de recarga llega partido: el tablero por un
// lado, el surtidor por otro, la nota al final. Eso está bien. Lo que estaba mal es lo que el
// prompt hacía con esa ráfaga: le ordenaba al modelo *"combínalos en UNA sola extracción — no
// los trates por separado"*, sin ninguna excepción.
//
// Y un conductor no siempre manda un reporte: al cerrar el turno fotografía los vouchers del
// DÍA y los manda juntos. Pasó tal cual el 20-08 — dos notas de COESTI en la misma ráfaga:
//
//     V70S-00043064 · 05:36 · placa CTV370 · 7.430 gal × 24.230 = S/ 180.03 · km 27,834
//     V70S-00043083 · 17:08 · placa BUI272 · 9.928 gal × 24.230 = S/ 240.56 · km 175,112
//
// Dos placas, dos comprobantes, once horas de diferencia y S/ 240.56 que NO son los S/ 180.03
// del otro. El modelo hizo lo que se le pidió: una sola extracción. Resultado: una recarga con
// la placa de un voucher y los números del otro, y **la segunda recarga desaparecida** — un
// gasto real que ninguna pantalla del ERP volvería a mostrar.
//
// `multiples_recargas_en_cluster` existía como código de anomalía y como etiqueta de la
// pantalla desde el día uno… y NINGÚN código lo levantaba nunca. Estaba declarado y sin
// conectar, así que la fusión ocurría en silencio absoluto.
//
// LO QUE HACE ESTE MÓDULO: leer cuántos despachos DISTINTOS declara la extracción y devolver
// los adicionales ya normalizados, para que acciones.ts les dé una fila propia en vez de
// perderlos. Y cruzar dos señales del modelo, no una: la lista de recargas que extrajo y la
// lista de comprobantes que dice haber visto. Si vio dos y extrajo una, el dato se está
// perdiendo igual — y eso también hay que decirlo.
//
// Y COMO AQUÍ VIVE LA IDENTIDAD DE UN DESPACHO, aquí vive también `buscarDuplicado`. El
// chequeo anterior preguntaba por `placa + fecha + monto`, y la placa es justo lo que no se
// puede dar por bueno: el mismo voucher V70S-00043064 (CTV370, 7.430 gal, S/ 180.03) entró
// DOS VECES —una atribuida a BUI-272 y otra a CTV-370— y como las placas no coincidían, el
// `.eq("placa", …)` no las comparó nunca y no salió ninguna advertencia. El **número de la
// nota de despacho** es la identidad del papel: dos filas con el mismo comprobante son el
// mismo despacho, venga con la placa que venga.

/** Una recarga adicional del álbum, con la forma mínima para darle su propia fila. */
export type RecargaAlbum = {
  placa: string | null;
  comprobante: string | null;
  fecha: string | null;
  hora: string | null;
  grifo: string | null;
  tipoCombustible: string | null;
  galones: number | null;
  litros: number | null;
  precioGalon: number | null;
  precioLitro: number | null;
  montoTotal: number | null;
  kilometraje: number | null;
};

export type AlbumRecargas = {
  /** Las recargas ADICIONALES: la primera vive en los campos planos de la extracción. */
  adicionales: RecargaAlbum[];
  /** Comprobantes distintos que el álbum declara (el principal incluido), como se leyeron. */
  comprobantes: string[];
  /** Cuántos despachos distintos trae el álbum, según la mejor evidencia disponible. */
  total: number;
  /** Más de un despacho: la ráfaga NO es un solo reporte. */
  multiple: boolean;
  /**
   * La IA declaró ver más de un comprobante pero no extrajo los otros. El dato de esas
   * recargas se pierde igual, así que el aviso no puede depender de que las haya extraído.
   */
  incompleto: boolean;
  /** Texto listo para la anomalía. "" cuando el álbum trae un solo despacho. */
  detalle: string;
};

// ── Normalización ────────────────────────────────────────────────────────────

/** Comprobante comparable: solo alfanumérico en mayúsculas ("V70S-00043064" → "V70S00043064"). */
const normComprobante = (s: unknown): string =>
  String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Placa comparable (mismo criterio que placaNorm en acciones.ts). */
const normPlaca = (s: unknown): string => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const txt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

const soles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Una recarga sin ningún número no es una recarga: es ruido que ensuciaría la cola de revisión. */
const tieneDatos = (r: RecargaAlbum) =>
  r.galones != null || r.litros != null || r.montoTotal != null || r.comprobante != null;

/**
 * ¿Estas dos filas son el MISMO despacho? Por comprobante cuando los dos lo traen (es el
 * identificador que imprime el grifo); si no, por placa + importe, que es lo más cercano a una
 * identidad que queda. Sirve para no duplicar el principal cuando el modelo lo repite dentro
 * de la lista de adicionales.
 */
function mismoDespacho(a: RecargaAlbum, b: { comprobante: string | null; placa: string | null; monto: number | null }): boolean {
  const ca = normComprobante(a.comprobante);
  const cb = normComprobante(b.comprobante);
  if (ca && cb) return ca === cb;
  const pa = normPlaca(a.placa);
  const pb = normPlaca(b.placa);
  if (pa && pb && pa !== pb) return false;
  if (a.montoTotal != null && b.monto != null) return Math.abs(a.montoTotal - b.monto) < 0.005;
  return false;
}

/** Normaliza una entrada cruda de `recargas_adicionales`. */
function leerRecarga(v: unknown): RecargaAlbum | null {
  if (v == null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const r: RecargaAlbum = {
    placa: txt(o.placa),
    comprobante: txt(o.comprobante),
    fecha: txt(o.fecha),
    hora: txt(o.hora),
    grifo: txt(o.grifo),
    tipoCombustible: txt(o.tipo_combustible),
    galones: num(o.galones),
    litros: num(o.litros),
    precioGalon: num(o.precio_galon),
    precioLitro: num(o.precio_litro),
    montoTotal: num(o.monto_total),
    kilometraje: num(o.kilometraje),
  };
  return tieneDatos(r) ? r : null;
}

// ── Lectura del álbum ────────────────────────────────────────────────────────

const vacio: AlbumRecargas = {
  adicionales: [],
  comprobantes: [],
  total: 1,
  multiple: false,
  incompleto: false,
  detalle: "",
};

/**
 * Cuántos despachos distintos trae el álbum y cuáles son los adicionales.
 *
 * `principal` son los campos planos de la extracción (la primera recarga). Todo lo que
 * coincida con ella se descarta de la lista: un modelo que repite el principal dentro de
 * `recargas_adicionales` no está declarando dos despachos.
 */
export function leerAlbumRecargas(
  datos: {
    recargas_adicionales?: unknown;
    comprobantes_vistos?: unknown;
  },
  principal: { comprobante: string | null; placa: string | null; monto: number | null }
): AlbumRecargas {
  const crudas = Array.isArray(datos.recargas_adicionales) ? datos.recargas_adicionales : [];
  const adicionales: RecargaAlbum[] = [];
  for (const c of crudas) {
    const r = leerRecarga(c);
    if (!r) continue;
    if (mismoDespacho(r, principal)) continue; // es el principal repetido
    // Y tampoco se repite entre ellas.
    const yaEsta = adicionales.some((x) =>
      mismoDespacho(r, { comprobante: x.comprobante, placa: x.placa, monto: x.montoTotal })
    );
    if (!yaEsta) adicionales.push(r);
  }

  // Comprobantes distintos: los que la IA dice haber visto, más el principal y los adicionales.
  const vistos = Array.isArray(datos.comprobantes_vistos) ? datos.comprobantes_vistos : [];
  const comprobantes: string[] = [];
  const clavesVistas = new Set<string>();
  for (const c of [principal.comprobante, ...adicionales.map((a) => a.comprobante), ...vistos]) {
    const s = txt(c);
    if (!s) continue;
    const k = normComprobante(s);
    if (!k || clavesVistas.has(k)) continue;
    clavesVistas.add(k);
    comprobantes.push(s);
  }

  const total = Math.max(1 + adicionales.length, comprobantes.length || 1);
  if (total <= 1) return { ...vacio, comprobantes };

  // La IA vio más comprobantes de los que extrajo: los que faltan se pierden igual, así que
  // el aviso NO puede depender de que los haya extraído.
  const incompleto = comprobantes.length > 1 + adicionales.length;

  return {
    adicionales,
    comprobantes,
    total,
    multiple: true,
    incompleto,
    detalle: detalleAlbum(total, adicionales, comprobantes, incompleto),
  };
}

// ── ¿Este despacho ya está en el ERP? ────────────────────────────────────────

/** Una fila de `radar_combustible` ya guardada, con lo justo para compararla. */
export type DespachoGuardado = {
  id: string;
  placa: string | null;
  fecha: string | null;
  comprobante: string | null;
  monto: number | null;
  cantidad: number | null;
};

/** La recarga que se está evaluando ahora. */
export type LecturaDespacho = {
  placa: string | null;
  fecha: string | null;
  comprobante: string | null;
  monto: number | null;
  cantidad: number | null;
};

export type DuplicadoDespacho = {
  id: string;
  /** Por qué se considera el mismo despacho. */
  por: "comprobante" | "misma_placa" | "otra_placa";
  detalle: string;
};

const soles2 = (n: number | null) => (n == null ? "—" : soles(n));

/**
 * ¿Alguna de las filas guardadas es ESTE mismo despacho? Tres criterios, del más fuerte al
 * más débil, y el orden importa porque el primero que acierta gana:
 *
 *  1. **Mismo comprobante.** Es el nº que imprime el grifo: identifica el papel. No mira placa
 *     ni fecha — una foto reenviada la semana siguiente sigue siendo el mismo despacho, y una
 *     mal atribuida a otra unidad también. Este es el criterio que faltaba.
 *  2. **Misma placa, misma fecha, mismo importe** (±S/ 1): el chequeo de siempre, para cuando
 *     el comprobante no se pudo leer en alguno de los dos.
 *  3. **OTRA placa, misma fecha, mismo importe Y misma cantidad**: o es el mismo voucher mal
 *     atribuido, o dos cargas idénticas al céntimo y al milésimo de galón el mismo día. Se
 *     exigen los DOS números justamente para que no salte por casualidad: un surtidor entrega
 *     volumen continuo, y que dos unidades coincidan en importe *y* en 7.430 galones no pasa
 *     por azar. Con solo el importe no se levanta nada — llenar por S/ 100 redondos es lo
 *     normal, y ahí sí serían dos cargas distintas.
 */
export function buscarDuplicado(
  lectura: LecturaDespacho,
  guardados: DespachoGuardado[]
): DuplicadoDespacho | null {
  const filas = (guardados ?? []).filter((g) => g?.id);
  const comp = normComprobante(lectura.comprobante);
  if (comp) {
    const porComp = filas.find((g) => normComprobante(g.comprobante) === comp);
    if (porComp) {
      return {
        id: porComp.id,
        por: "comprobante",
        detalle:
          `El comprobante ${lectura.comprobante} ya está capturado${porComp.placa ? ` (a nombre de ${porComp.placa})` : ""}` +
          `${porComp.fecha ? ` con fecha ${porComp.fecha}` : ""} por ${soles2(porComp.monto)} — es la MISMA nota de despacho, ` +
          `así que esta lectura la duplicaría. Si las dos filas describen el mismo papel, descarta una.`,
      };
    }
  }

  if (lectura.monto == null || !lectura.fecha) return null;
  const mismaFecha = filas.filter((g) => g.fecha === lectura.fecha && g.monto != null);
  const placa = normPlaca(lectura.placa);

  const mismoImporte = (g: DespachoGuardado) => Math.abs((g.monto as number) - (lectura.monto as number)) < 1;

  if (placa) {
    const igual = mismaFecha.find((g) => normPlaca(g.placa) === placa && mismoImporte(g));
    if (igual) {
      return {
        id: igual.id,
        por: "misma_placa",
        detalle: `El Radar ya capturó una carga de ${lectura.placa} el ${lectura.fecha} por ${soles2(igual.monto)}`,
      };
    }
  }

  // Cruce de placas: exige importe Y cantidad, para no acusar dos cargas legítimas del día.
  if (lectura.cantidad != null) {
    const cruzado = mismaFecha.find(
      (g) =>
        normPlaca(g.placa) !== placa &&
        mismoImporte(g) &&
        g.cantidad != null &&
        Math.abs(g.cantidad - (lectura.cantidad as number)) < 0.001
    );
    if (cruzado) {
      return {
        id: cruzado.id,
        por: "otra_placa",
        detalle:
          `Ya hay una carga del ${lectura.fecha} por ${soles2(cruzado.monto)} y ${cruzado.cantidad} de cantidad, idéntica a esta ` +
          `pero a nombre de ${cruzado.placa ?? "otra unidad"} (esta dice ${lectura.placa ?? "sin placa"}). ` +
          `Coincidir en importe Y en cantidad exacta el mismo día no pasa por azar: casi siempre es el MISMO voucher ` +
          `atribuido a dos unidades. Confirma cuál es la correcta y descarta la otra.`,
      };
    }
  }

  return null;
}

function detalleAlbum(
  total: number,
  adicionales: RecargaAlbum[],
  comprobantes: string[],
  incompleto: boolean
): string {
  const lista = comprobantes.length ? ` (${comprobantes.join(", ")})` : "";
  const cabecera =
    `La ráfaga de fotos no es UN reporte: trae ${total} despachos distintos${lista}. ` +
    `Se agrupan por remitente y hora, y un conductor manda juntos los vouchers del día — ` +
    `mezclarlos daría una recarga con la placa de un voucher y los importes de otro.`;
  const extras = adicionales.length
    ? ` Se abrió una fila aparte por cada una: ${adicionales
        .map((a) => {
          const partes = [a.placa ?? "sin placa"];
          const cant = a.galones ?? a.litros;
          if (cant != null) partes.push(`${cant} ${a.galones != null ? "gal" : "lt"}`);
          if (a.montoTotal != null) partes.push(soles(a.montoTotal));
          if (a.comprobante) partes.push(a.comprobante);
          return partes.join(" · ");
        })
        .join(" | ")}.`
    : "";
  const aviso = incompleto
    ? ` OJO: la IA declaró ver ${comprobantes.length} comprobantes pero solo extrajo ${1 + adicionales.length}; ` +
      `los que faltan hay que cargarlos a mano desde las fotos.`
    : "";
  return `${cabecera}${extras}${aviso} Confirma cada una contra su foto antes de registrar.`;
}
