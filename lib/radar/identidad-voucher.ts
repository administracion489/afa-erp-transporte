// lib/radar/identidad-voucher.ts — Quién vende, quién compra, y qué se comparó con qué.
// Módulo PURO (no toca la base ni secretos), como lib/radar/coherencia-voucher.ts. Lo consume
// lib/radar/acciones.ts (accionCombustible) y lo prueba scripts/prueba-voucher.mts.
//
// ── 1. EL GRIFO NO ES EL "RAZ.SOC" ──────────────────────────────────────────
// Una nota de despacho de grifo trae DOS empresas, y el ERP solo quiere la que VENDE:
//
//     COESTI S.A. - RUC: 20127765279        ← EL GRIFO (encabezado, arriba del título)
//     E/S MACARENA
//     Z.I. ZONA INDUSTRIAL Mz 251 …
//     ------- NOTA DE DESPACHO -------
//     RAZ.SOC : GLOBAL BUS PERU S.A.C.      ← EL CLIENTE (quien compró el combustible)
//     RUC     : 20611105291
//     DIRECC  : PJ. SANTA ISABEL NRO. 380
//
// El prompt pedía "razón social — SOLO de la nota" y la nota tiene un campo rotulado
// literalmente `RAZ.SOC` («razón social»)… que es el del COMPRADOR. El modelo hacía
// exactamente lo que se le pedía y guardaba como grifo a GLOBAL BUS PERÚ S.A.C. — el
// transportista dueño del bus — y en otra fila a AFA TOURS PERÚ S.A.C., la propia empresa.
//
// La corrección del prompt es la mitad. La otra es este guard, y tiene una evidencia que el
// modelo no puede tener: **el ERP ya sabe cómo se llama y quiénes son sus tercerizadas.** Una
// empresa que el sistema conoce como propia o como operador contratado NO PUEDE ser el grifo
// de su propio voucher de combustible — es, por definición, la que compró. Mismo criterio que
// `esMarcaKitGLP` en acciones.ts: una lista de entidades conocidas que gana sobre una
// extracción que "se ve bien".
//
// ── 2. NO SE COMPARA CONTRA UNA FOTO QUE NO SE VIO ──────────────────────────
// `discrepancias` es un cajón de texto libre que el modelo llena con cualquier diferencia que
// note, pero acciones.ts etiquetaba TODAS como `discrepancia_maquina_vs_nota` («el surtidor
// no coincide con la nota»). En un reporte de dos fotos —la nota y el TABLERO, sin ninguna
// del surtidor— eso acusa a una máquina que nadie fotografió. Acá la discrepancia declara
// ENTRE QUÉ dos fuentes es, y se contrasta contra las fotos que realmente se vieron: una
// comparación contra una foto ausente no es una discrepancia, es una afirmación sin respaldo,
// y baja a observación en vez de nombrar al surtidor.

// ── Normalización de nombres de empresa ──────────────────────────────────────

/**
 * Nombre de empresa comparable: sin tildes, sin puntuación y **sin la forma societaria**.
 * "GLOBAL BUS PERÚ S.A.C." y "Global Bus Peru SAC" son la misma empresa escrita por dos
 * personas distintas, y el sufijo legal no distingue a nadie.
 */
export function normEmpresa(s?: string | null): string {
  const base = String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return base
    .replace(/\bSOCIEDAD ANONIMA( CERRADA)?\b/g, " ")
    // Alternativas de más largo a más corto: "S A C" tiene que ganarle a "S A".
    .replace(/\b(S A C|E I R L|S R L|S A|SAC|EIRL|SRL|SA)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** RUC comparable: solo dígitos. */
const soloDigitos = (s?: string | null) => String(s ?? "").replace(/\D/g, "");

/** Las empresas que el ERP ya conoce como suyas: la propia y las tercerizadas. */
export type EmpresasConocidas = {
  /** Razones sociales tal como están en la base (se normalizan acá). */
  nombres: string[];
  /** RUC de esas mismas empresas. */
  rucs: string[];
};

/**
 * ¿`nombre` es una de las empresas conocidas? Exacto tras normalizar, o uno PREFIJO O SUFIJO
 * del otro cuando el más corto ya es largo de por sí (≥ 12 caracteres): "TRANSPORTES GLOBAL
 * BUS PERU" y "GLOBAL BUS PERU" son la misma empresa con y sin el giro adelante.
 *
 * Prefijo/sufijo y no "contiene", que es la diferencia entre acertar y borrar un grifo bueno:
 * una tercerizada llamada "SERVICIOS GENERALES" está CONTENIDA en "ESTACIÓN DE SERVICIOS
 * GENERALES DEL NORTE", que es un grifo de verdad — y como esta anomalía bloquea, un falso
 * positivo le cuesta al operador una revisión por un dato que estaba bien. Por debajo de 12
 * caracteres no se compara más que exacto: "BUS" o "AFA" dentro de otro nombre no prueban nada.
 */
export function esEmpresaConocida(nombre: string | null | undefined, conocidas: EmpresasConocidas): string | null {
  const n = normEmpresa(nombre);
  if (n.length < 4) return null;
  for (const bruto of conocidas.nombres) {
    const c = normEmpresa(bruto);
    if (!c) continue;
    if (c === n) return bruto;
    const corto = c.length <= n.length ? c : n;
    const largo = c.length <= n.length ? n : c;
    if (corto.length < 12) continue;
    // Pegado a un borde y cortando por palabra completa, nunca a media palabra.
    if (largo.startsWith(corto + " ") || largo.endsWith(" " + corto)) return bruto;
  }
  return null;
}

/** ¿Este RUC es de una de las empresas conocidas? */
export function esRucConocido(ruc: string | null | undefined, conocidas: EmpresasConocidas): boolean {
  const r = soloDigitos(ruc);
  if (r.length !== 11) return false;
  return conocidas.rucs.some((x) => soloDigitos(x) === r);
}

/**
 * Marcas y palabras que solo aparecen en el nombre de quien VENDE combustible. Se usa para
 * un único fin: cuando el modelo invirtió las dos empresas, reconocer al grifo del otro lado.
 * No sirve para validar un grifo (hay estaciones independientes con nombre de persona), solo
 * para desempatar una inversión ya probada por el otro extremo.
 */
const MARCAS_GRIFO = [
  "COESTI", "PRIMAX", "REPSOL", "PETROPERU", "PETRO PERU", "PECSA", "PERUANA DE ESTACIONES",
  "TERPEL", "SHELL", "GAZEL", "LLAMAGAS", "SOLGAS", "LIMA GAS", "HERCO", "DELTA",
  "GRIFO", "GRIFOS", "ESTACION DE SERVICIO", "ESTACIONES DE SERVICIO", "SERVICENTRO",
  "PETROLERA", "PETROLEOS", "COMBUSTIBLES", "ENERGIGAS", "NEOGAS", "GNV", "REPSOL COMERCIAL",
];

/** ¿El nombre suena a estación de servicio? (solo desempata una inversión, ver arriba). */
export function pareceGrifo(nombre?: string | null): boolean {
  const n = normEmpresa(nombre);
  if (!n) return false;
  return MARCAS_GRIFO.some((m) => n.includes(m));
}

// ── Resolución de identidad ──────────────────────────────────────────────────

export type IdentidadLeida = {
  grifo: string | null;
  proveedor: string | null;
  ruc: string | null;
  direccionGrifo: string | null;
  /** Razón social del COMPRADOR, si el modelo la separó ("RAZ.SOC"/"CLIENTE"). */
  clienteEnNota: string | null;
};

export type ResolucionIdentidad = {
  grifo: string | null;
  proveedor: string | null;
  ruc: string | null;
  direccionGrifo: string | null;
  anomalia: {
    codigo: "cliente_como_grifo" | "ruc_del_cliente";
    detalle: string;
    bloquea: boolean;
  } | null;
};

/**
 * Corrige la confusión vendedor↔comprador de la nota de despacho.
 *
 * Dos casos, y ninguno inventa un grifo:
 *  - El "grifo" extraído es una empresa que el ERP conoce como PROPIA o TERCERIZADA → es el
 *    comprador. Si el modelo dejó del otro lado (`cliente_en_nota`) un nombre que sí es de
 *    estación de servicio, invirtió los dos y se intercambian; si no, se BORRA el grifo (con
 *    su RUC y su dirección, que vienen del mismo bloque del cliente) y se avisa. Preferir el
 *    hueco a un dato falso: "COESTI" en blanco se nota; "GLOBAL BUS PERÚ" como grifo pasa por
 *    bueno y ensucia el histórico de precios por estación.
 *  - El nombre del grifo está bien pero el RUC es el del comprador → se suelta solo el RUC y
 *    la dirección, sin bloquear: el gasto está bien imputado, solo sobra un dato del cliente.
 */
export function resolverIdentidadGrifo(l: IdentidadLeida, conocidas: EmpresasConocidas): ResolucionIdentidad {
  const intacto: ResolucionIdentidad = {
    grifo: l.grifo,
    proveedor: l.proveedor,
    ruc: l.ruc,
    direccionGrifo: l.direccionGrifo,
    anomalia: null,
  };
  if (!conocidas.nombres.length && !conocidas.rucs.length) return intacto;

  const porNombre = esEmpresaConocida(l.grifo, conocidas) ?? esEmpresaConocida(l.proveedor, conocidas);
  const rucDelCliente = esRucConocido(l.ruc, conocidas);

  if (porNombre) {
    const nombreLeido = (l.grifo ?? l.proveedor ?? porNombre).trim();
    if (pareceGrifo(l.clienteEnNota)) {
      const real = String(l.clienteEnNota).trim();
      return {
        grifo: real,
        proveedor: real,
        // El RUC y la dirección salieron del bloque del cliente junto con el nombre: se
        // sueltan. El del grifo está en el encabezado, y si el modelo no lo leyó no se inventa.
        ruc: null,
        direccionGrifo: null,
        anomalia: {
          codigo: "cliente_como_grifo",
          detalle:
            `El voucher venía con las dos empresas invertidas: "${nombreLeido}" es ${quienEs(porNombre, conocidas)} ` +
            `y en la nota figura como CLIENTE ("RAZ.SOC"), no como grifo. El grifo es "${real}", que estaba en el otro campo — ` +
            `se intercambiaron. Se soltaron el RUC y la dirección porque eran los del cliente.`,
          bloquea: true,
        },
      };
    }
    return {
      grifo: null,
      proveedor: null,
      ruc: null,
      direccionGrifo: null,
      anomalia: {
        codigo: "cliente_como_grifo",
        detalle:
          `"${nombreLeido}" es ${quienEs(porNombre, conocidas)}: en la nota de despacho es el CLIENTE que compró ` +
          `(el campo "RAZ.SOC"), no la estación que vendió. El grifo se imprime en el ENCABEZADO, arriba del título. ` +
          `Se dejó el grifo en blanco antes que guardar al comprador — complétalo mirando la foto.`,
        bloquea: true,
      },
    };
  }

  if (rucDelCliente) {
    return {
      grifo: l.grifo,
      proveedor: l.proveedor,
      ruc: null,
      direccionGrifo: null,
      anomalia: {
        codigo: "ruc_del_cliente",
        detalle:
          `El RUC ${soloDigitos(l.ruc)} es el del comprador (una empresa del ERP), no el del grifo — sale del bloque ` +
          `"RAZ.SOC / RUC / DIRECC" de la nota. Se soltaron el RUC y la dirección; el nombre del grifo se conservó.`,
        bloquea: false,
      },
    };
  }

  return intacto;
}

/** "la propia empresa" / "una empresa tercerizada del ERP", para el texto de la anomalía. */
function quienEs(nombre: string, conocidas: EmpresasConocidas): string {
  // El primer nombre de la lista es siempre el de `empresa_perfil` (ver cargarEmpresasConocidas).
  return conocidas.nombres[0] && normEmpresa(conocidas.nombres[0]) === normEmpresa(nombre)
    ? "la propia empresa"
    : "una empresa tercerizada registrada en el ERP";
}

// ── Discrepancias ────────────────────────────────────────────────────────────

/** Una diferencia entre dos fuentes, ya normalizada. */
export type Discrepancia = {
  campo: string | null;
  /** "surtidor_vs_nota" | "tablero_vs_nota" | "otro" */
  entre: string | null;
  detalle: string;
};

/**
 * Acepta la forma nueva (objeto con `entre`) y la vieja (string suelto), porque las filas ya
 * guardadas y cualquier modelo que se salte el esquema siguen mandando texto. Un string no
 * declara entre qué fuentes es → `entre: null`, que abajo se resuelve como observación.
 */
export function normalizarDiscrepancias(raw: unknown): Discrepancia[] {
  if (!Array.isArray(raw)) return [];
  const out: Discrepancia[] = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ campo: null, entre: null, detalle: t });
      continue;
    }
    if (typeof item === "object") {
      const o = item as Record<string, unknown>;
      const detalle = String(o.detalle ?? o.descripcion ?? "").trim();
      if (!detalle) continue;
      out.push({
        campo: o.campo == null ? null : String(o.campo),
        entre: o.entre == null ? null : String(o.entre),
        detalle,
      });
    }
  }
  return out;
}

export type FotosVistas = { vioSurtidor: boolean; vioNota: boolean; vioTablero: boolean };

/**
 * Con qué código entra una discrepancia. La regla dura: **una comparación contra una foto que
 * no se vio no se etiqueta como esa comparación.** Sin foto del surtidor no puede haber un
 * "el surtidor no coincide con la nota" — eso fue exactamente lo que apareció en un reporte
 * cuya segunda foto era el tablero. Sin la declaración `entre` (strings viejos) tampoco se
 * adivina: se guarda como observación, que es lo que de verdad se sabe.
 */
export function codigoDeDiscrepancia(
  d: Discrepancia,
  fotos: FotosVistas
): "discrepancia_maquina_vs_nota" | "discrepancia_km_tablero_vs_nota" | "observacion_lectura" {
  if (d.entre === "surtidor_vs_nota" && fotos.vioSurtidor && fotos.vioNota) return "discrepancia_maquina_vs_nota";
  if (d.entre === "tablero_vs_nota" && fotos.vioTablero) return "discrepancia_km_tablero_vs_nota";
  return "observacion_lectura";
}

/** Texto de la anomalía, avisando cuando la comparación citaba una foto que no llegó. */
export function detalleDeDiscrepancia(d: Discrepancia, fotos: FotosVistas): string {
  const base = d.detalle.slice(0, 240);
  if (d.entre === "surtidor_vs_nota" && !fotos.vioSurtidor) {
    return `${base} · (la IA la describió como surtidor vs nota, pero en el reporte no hay ninguna foto del surtidor)`;
  }
  if (d.entre === "tablero_vs_nota" && !fotos.vioTablero) {
    return `${base} · (la IA la describió como tablero vs nota, pero en el reporte no hay ninguna foto del tablero)`;
  }
  return base;
}
