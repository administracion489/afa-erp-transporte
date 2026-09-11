// lib/costos/parametros.ts — La ÚNICA puerta para escribir en `parametros_costos`.
//
// POR QUÉ EXISTE. `guardarParam` (app/configuracion/costos/page.tsx) hacía esto:
//
//     await supabase.from("parametros_costos").update({ [campo]: vN }).eq("tipo_vehiculo", vehId);
//     await supabase.from("historial_costos").insert({ … });
//     mostrarAlerta(`✅ ${vehId} · Rendimiento: 19.00 → 28.50`);
//
// Dos `await` sueltos cuyo resultado se DESCARTA, y un toast verde incondicional. Si el
// update no tocó ninguna fila —RLS, una clave que ya no existe, un typo— la pantalla decía
// igualmente "✅ 19.00 → 28.50" y al recargar volvía el 19.00. Es el fallo (2) de los tres
// que costó el PAX contratado: *"se guardó" y al recargar el número viejo, que es la peor
// forma de fallar porque hace dudar de lo que uno acaba de teclear.*
//
// Con una persona tecleando eso es feo. Con un botón que mueve el S/km de un tipo un 20 %
// —lo que viene detrás de esta puerta— es inaceptable.
//
// LA CLAVE `tipo_vehiculo` NO ES ÚNICA EN LA BASE. No hay DDL versionado de esta tabla en el
// repo, el alta (`FormNuevoVeh`) no impide reusar una clave existente y `desactivarVeh` no
// borra: solo pone `activo = false`. Mientras tanto `lib/costeo-servicio.ts` lee esa misma
// clave con `.maybeSingle()`. Con dos filas iguales, una edición toca las dos y la lectura
// elige una al azar.
//
// POR ESO SE PREGUNTA ANTES DE ESCRIBIR, y no después con `.select()`: un `update` que ya
// tocó dos filas no se deshace devolviendo `ok:false`. La consulta previa cuesta un viaje de
// red en una acción que dispara una persona pulsando un botón, y es lo único que convierte
// el problema en un mensaje en vez de en dos filas divergentes.
//
// `supabase/costos-01-identidad-tipo-vehiculo.sql` crea el índice único que hace imposible
// llegar a ese estado. La funcionalidad NO depende de que se haya corrido: sin la migración
// esta función protege igual, con una comprobación por escritura. Es el mismo criterio que
// `COLUMNAS_OPCIONALES` — un ERP al que le falte un SQL accesorio tiene que poder corregir
// un parámetro igual.

import {
  CAMPO_DESCARTE, motivoHistorial, procedenciaDeHistorial,
  type AgregadoTipo, type Procedencia,
} from "./rendimiento-tipo";
import {
  CAMPO_DESCARTE_MANT, CAMPOS_PROCEDENCIA_MANT, motivoHistorialMant, procedenciaMantDeHistorial,
  type AgregadoMant, type ProcedenciaMant,
} from "./mantenimiento-tipo";
import { paginarFilas } from "@/lib/huella";

/** Una fila de `historial_costos`. El historial es POR CAMPO (`campo_modificado`) desde
 *  siempre, así que un patch que toca varias columnas deja varias. */
export type ActaParametro = {
  campo_modificado: string;
  valor_anterior: number | null;
  valor_nuevo: number | null;
  motivo: string;
};

/** Lo que se escribe, y el acta que lo justifica. Los dos van juntos o no va ninguno. */
export type EscrituraParametro = {
  /** La clave de `parametros_costos`. Se usa CRUDA: se normaliza al crear el tipo y en
   *  ningún otro sitio. Normalizarla aquí inventaría una tercera identidad. */
  tipo_vehiculo: string;
  /** Las columnas a escribir. `updated_by` lo pone esta función. */
  patch: Record<string, unknown>;
  /** La fila de `historial_costos`, o UNA POR CAMPO cuando el patch toca varias columnas (la
   *  ficha del tipo: nombre, capacidad, grupo, ícono). Sin acta no se escribe: es la razón de
   *  ser de la tabla. Un acta resumen dejaría un cambio de capacidad sin sus dos números, que
   *  es justo lo que la columna "Variación" del historial lee. */
  acta: ActaParametro | ActaParametro[];
  /** Quién firma. El correo de la persona, nunca un literal de sistema. */
  por: string;
};

export type ResultadoEscritura = {
  /** true solo si se escribió EXACTAMENTE una fila de `parametros_costos`. */
  ok: boolean;
  /** Filas que tenían esa clave. 0 = no existe · 2+ = clave duplicada, no se escribió nada. */
  filas: number;
  /** Si quedaron TODAS las actas. Puede ser false con `ok: true`: el parámetro se guardó y la
   *  auditoría no. La pantalla tiene que decirlo — callarlo sería prometer una trazabilidad
   *  que no hay. */
  acta: boolean;
  /** Qué salió mal, en el idioma del operador y nombrando el arreglo. */
  error?: string;
};

const TABLA = "parametros_costos";

/**
 * Escribe un parámetro y su acta, o no escribe nada y dice por qué.
 *
 * Nunca lanza: devuelve el resultado para que la pantalla decida qué pintar. Un `throw`
 * dentro de un `onBlur` de una celda editable se pierde en la consola.
 */
export async function escribirParametro(sb: any, e: EscrituraParametro): Promise<ResultadoEscritura> {
  const clave = e.tipo_vehiculo;

  // 1 · CUÁNTAS FILAS TIENE ESA CLAVE. Antes de escribir, no después.
  //     Sin filtrar por `activo`: un duplicado desactivado sigue siendo un duplicado para el
  //     `.eq()` del update, que tampoco filtra.
  const { data: existentes, error: errSel } = await sb.from(TABLA).select("id").eq("tipo_vehiculo", clave);
  if (errSel) {
    return { ok: false, filas: 0, acta: false, error: `No se pudo comprobar el tipo "${clave}": ${errSel.message}` };
  }
  const filas = (existentes as any[] | null)?.length ?? 0;

  if (filas === 0) {
    return {
      ok: false, filas: 0, acta: false,
      error: `No existe ningún tipo de vehículo con clave "${clave}". No se escribió nada.`,
    };
  }
  if (filas > 1) {
    return {
      ok: false, filas, acta: false,
      error:
        `Hay ${filas} filas en parametros_costos con la clave "${clave}", así que este cambio ` +
        `habría escrito en ${filas} tipos a la vez. No se escribió nada. Corre ` +
        `supabase/costos-01-identidad-tipo-vehiculo.sql (trae la consulta que dice cuál conservar).`,
    };
  }

  // 2 · ESCRIBIR, y comprobar que de verdad se tocó una fila. Con RLS de por medio un update
  //     que no alcanza nada devuelve 0 filas y NINGÚN error: ese es el silencio que se corta.
  const { data: tocadas, error: errUpd } = await sb
    .from(TABLA)
    .update({ ...e.patch, updated_by: e.por })
    .eq("tipo_vehiculo", clave)
    .select("id");
  if (errUpd) {
    return { ok: false, filas: 0, acta: false, error: `No se pudo guardar "${clave}": ${errUpd.message}` };
  }
  const escritas = (tocadas as any[] | null)?.length ?? 0;
  if (escritas !== 1) {
    return {
      ok: false, filas: escritas, acta: false,
      error:
        `El guardado de "${clave}" no tocó ninguna fila (permisos, o la fila cambió mientras ` +
        `editabas). El valor NO se guardó: vuelve a cargar la pantalla y compruébalo.`,
    };
  }

  // 3 · EL ACTA (o una por campo). Solo aquí, y solo porque se escribió exactamente una fila.
  //     Insertarlas antes dejaría en el historial un cambio que no ocurrió, que es peor que no
  //     tener historial. Van en un solo insert: o entran todas o no entra ninguna, y así el
  //     historial no describe media edición.
  const actas = Array.isArray(e.acta) ? e.acta : [e.acta];
  const { error: errActa } = actas.length
    ? await sb.from("historial_costos").insert(actas.map(a => ({
        tabla_origen: TABLA,
        tipo_vehiculo: clave,
        campo_modificado: a.campo_modificado,
        valor_anterior: a.valor_anterior,
        valor_nuevo: a.valor_nuevo,
        motivo: a.motivo,
        cambiado_por: e.por,
      })))
    : { error: null };

  return {
    ok: true,
    filas: 1,
    acta: !errActa,
    error: errActa
      ? `El parámetro se guardó, pero no quedó registrado en el historial: ${errActa.message}`
      : undefined,
  };
}

// ─── EL RENDIMIENTO MEDIDO ────────────────────────────────────────────────────
//
// Las tres funciones de abajo son el puente entre lo que la flota MIDE
// (lib/costos/rendimiento-tipo.ts) y lo que el ERP COSTEA. Viven aquí, no en el módulo del
// agregado, por lo mismo que ese módulo es puro: la matriz tiene que poder correr sin base.

/** Los campos de `historial_costos` que hablan del rendimiento de un tipo. `tipo_combustible_1`
 *  entra porque CADUCA el sello: ver `procedenciaDeHistorial`. */
const CAMPOS_PROCEDENCIA = ["rendimiento_1", CAMPO_DESCARTE, "tipo_combustible_1"];

/**
 * Adopta la medición como parámetro.
 *
 * EL MOTIVO NO ES DECORACIÓN: `procedenciaDeHistorial` reconoce una adopción automática por su
 * prefijo `"Auto:"`, así que quien escribe y quien lee tienen que derivar el texto por el
 * mismo camino. Por eso lo compone `motivoHistorial` y no la pantalla — es el patrón que este
 * repo ya pagó tres veces en un día: escribir con una identidad y leer con otra.
 *
 * La nota del operador se ANEXA, nunca sustituye: un prefijo pisado dejaría la fila sin
 * procedencia y el chip volvería a proponer el número que se acaba de aplicar.
 */
export async function aplicarRendimientoMedido(
  sb: any, a: AgregadoTipo, por: string, nota?: string
): Promise<ResultadoEscritura> {
  // El candado vive aquí y no solo en el botón: es la última línea antes de mover el S/km de
  // un tipo. Un agregado que no es proponible es justamente el que no se puede escribir.
  if (!a.proponible || a.medido === null) {
    return {
      ok: false, filas: 0, acta: false,
      error: `La medición de "${a.tipoVehiculo}" no es aplicable (${a.codigo}). No se escribió nada.`,
    };
  }
  return escribirParametro(sb, {
    tipo_vehiculo: a.tipoVehiculo,
    patch: { rendimiento_1: a.medido },
    acta: {
      campo_modificado: "rendimiento_1",
      valor_anterior: a.parametro,
      valor_nuevo: a.medido,
      motivo: motivoHistorial(a) + (nota ? ` | ${nota}` : ""),
    },
    por,
  });
}

/**
 * Deja constancia de que una persona MIRÓ esta medición y decidió conservar el número tecleado.
 *
 * NO ESCRIBE EN `parametros_costos` — no hay nada que cambiar— así que no pasa por
 * `escribirParametro`: es un registro de DECISIÓN, no de cambio, y por eso `valor_anterior` va
 * en null. Poner ahí el tecleado pintaría en el historial una variación "19.00 → 28.50" que no
 * ocurrió, que es peor que no tener historial.
 *
 * Es lo único que apaga el chip. Sin esta fila, el mismo número reaparecería cada vez que se
 * abre la pantalla y en un mes sería paisaje — y el paisaje es lo que hace que el día que el
 * número cambie de verdad, nadie lo mire.
 */
export async function registrarDescarte(
  sb: any, a: AgregadoTipo, por: string, nota?: string
): Promise<{ ok: boolean; error?: string }> {
  if (a.medido === null) {
    return { ok: false, error: "No hay medición que descartar." };
  }
  const { error } = await sb.from("historial_costos").insert({
    tabla_origen: TABLA,
    tipo_vehiculo: a.tipoVehiculo,
    campo_modificado: CAMPO_DESCARTE,
    valor_anterior: null,
    valor_nuevo: a.medido,
    motivo:
      `Medición revisada y NO adoptada: ${a.medido} ${a.label ?? ""} · se conserva ${a.parametro}` +
      (nota ? ` | ${nota}` : ""),
    cambiado_por: por,
  });
  return error
    ? { ok: false, error: `No se pudo registrar la decisión: ${error.message}. El chip va a volver a salir.` }
    : { ok: true };
}

/**
 * La procedencia de cada tipo, derivada del historial. Sin columnas nuevas: el hecho ya está
 * registrado una vez, y copiarlo obligaría a mantener dos verdades y a explicar por qué
 * discrepan (la regla de oro de `finanzas-00-fundacion.sql`, aplicada a una decisión).
 *
 * Se pide PAGINADO y en orden ascendente estable. La pantalla ya trae un historial, pero
 * recortado a las 150 filas más nuevas: leer la procedencia de ahí haría que un tipo que no se
 * toca hace meses PIERDA su sello en cuanto otros tipos empujen sus filas fuera del corte, y
 * el chip volvería a proponer lo que ya se descartó. Es la misma trampa de leer con una
 * identidad lo que se escribió con otra, por la puerta del `limit`.
 */
export async function cargarProcedencias(sb: any): Promise<Map<string, Procedencia>> {
  return (await cargarProcedenciasCostos(sb)).rendimiento;
}

/**
 * Las procedencias de los DOS parámetros medidos, en UNA sola lectura del historial.
 *
 * Se leen juntas y no con dos funciones porque es la misma tabla y el mismo recorrido: dos
 * consultas paginadas para responder la misma pregunta sobre la misma fila es trabajo de más en
 * una pantalla que ya espera por la medición de la flota.
 *
 * Cada derivador ignora los campos que no son suyos, así que traer los cuatro `campo_modificado`
 * en el mismo `.in()` no mezcla nada.
 */
export async function cargarProcedenciasCostos(
  sb: any
): Promise<{ rendimiento: Map<string, Procedencia>; mantenimiento: Map<string, ProcedenciaMant> }> {
  const filas = await paginarFilas(() =>
    sb.from("historial_costos")
      .select("tipo_vehiculo,campo_modificado,valor_nuevo,motivo,cambiado_por,cambiado_en")
      .in("campo_modificado", [...CAMPOS_PROCEDENCIA, ...CAMPOS_PROCEDENCIA_MANT])
      .order("cambiado_en", { ascending: true })
      .order("id", { ascending: true })
  );

  const porTipo = new Map<string, any[]>();
  for (const f of filas as any[]) {
    const k = String(f.tipo_vehiculo ?? "");
    if (!k) continue;                       // filas de `precios_combustible`: no son de un tipo
    if (!porTipo.has(k)) porTipo.set(k, []);
    porTipo.get(k)!.push(f);
  }
  const rendimiento = new Map<string, Procedencia>();
  const mantenimiento = new Map<string, ProcedenciaMant>();
  for (const [k, fs] of porTipo) {
    rendimiento.set(k, procedenciaDeHistorial(fs));
    mantenimiento.set(k, procedenciaMantDeHistorial(fs));
  }
  return { rendimiento, mantenimiento };
}

// ─── EL MANTENIMIENTO MEDIDO ──────────────────────────────────────────────────
//
// Espejo exacto de las dos funciones del rendimiento, y por el mismo motivo: el número se
// propone, lo firma una persona y la escritura pasa por `escribirParametro`. Con una diferencia
// de signo que conviene tener presente al leer el `confirm()` de la pantalla: subir
// `mantenimiento_km` ENCARECE el S/km del tipo y sube el precio ofertado, mientras que bajar el
// rendimiento lo abarataba. Las dos direcciones mueven dinero; ninguna se aplica sola.

/**
 * Adopta el mantenimiento medido como parámetro.
 *
 * EL MOTIVO NO ES DECORACIÓN: `procedenciaMantDeHistorial` reconoce una adopción automática por
 * su prefijo `"Auto:"`, así que quien escribe y quien lee derivan el texto por el mismo camino.
 * Por eso lo compone `motivoHistorialMant` y no la pantalla.
 */
export async function aplicarMantenimientoMedido(
  sb: any, a: AgregadoMant, por: string, nota?: string
): Promise<ResultadoEscritura> {
  if (!a.proponible || a.medido === null) {
    return {
      ok: false, filas: 0, acta: false,
      error: `La medición de "${a.tipoVehiculo}" no es aplicable (${a.codigo}). No se escribió nada.`,
    };
  }
  return escribirParametro(sb, {
    tipo_vehiculo: a.tipoVehiculo,
    patch: { mantenimiento_km: a.medido },
    acta: {
      campo_modificado: "mantenimiento_km",
      valor_anterior: a.parametro,
      valor_nuevo: a.medido,
      motivo: motivoHistorialMant(a) + (nota ? ` | ${nota}` : ""),
    },
    por,
  });
}

/**
 * Deja constancia de que una persona MIRÓ esta medición y decidió conservar el número tecleado.
 *
 * NO ESCRIBE EN `parametros_costos` —no hay nada que cambiar— así que no pasa por
 * `escribirParametro`: es un registro de DECISIÓN, no de cambio, y por eso `valor_anterior` va
 * en null. Es lo único que apaga el chip; sin esta fila el mismo número reaparecería cada vez
 * que se abre la pantalla y en un mes sería paisaje.
 */
export async function registrarDescarteMant(
  sb: any, a: AgregadoMant, por: string, nota?: string
): Promise<{ ok: boolean; error?: string }> {
  if (a.medido === null) {
    return { ok: false, error: "No hay medición que descartar." };
  }
  const { error } = await sb.from("historial_costos").insert({
    tabla_origen: TABLA,
    tipo_vehiculo: a.tipoVehiculo,
    campo_modificado: CAMPO_DESCARTE_MANT,
    valor_anterior: null,
    valor_nuevo: a.medido,
    motivo:
      `Medición revisada y NO adoptada: ${a.medido} S/km · se conserva ${a.parametro}` +
      (nota ? ` | ${nota}` : ""),
    cambiado_por: por,
  });
  return error
    ? { ok: false, error: `No se pudo registrar la decisión: ${error.message}. El chip va a volver a salir.` }
    : { ok: true };
}
