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

/** Lo que se escribe, y el acta que lo justifica. Los dos van juntos o no va ninguno. */
export type EscrituraParametro = {
  /** La clave de `parametros_costos`. Se usa CRUDA: se normaliza al crear el tipo y en
   *  ningún otro sitio. Normalizarla aquí inventaría una tercera identidad. */
  tipo_vehiculo: string;
  /** Las columnas a escribir. `updated_by` lo pone esta función. */
  patch: Record<string, unknown>;
  /** La fila de `historial_costos`. Sin acta no se escribe: es la razón de ser de la tabla. */
  acta: {
    campo_modificado: string;
    valor_anterior: number | null;
    valor_nuevo: number | null;
    motivo: string;
  };
  /** Quién firma. El correo de la persona, nunca un literal de sistema. */
  por: string;
};

export type ResultadoEscritura = {
  /** true solo si se escribió EXACTAMENTE una fila de `parametros_costos`. */
  ok: boolean;
  /** Filas que tenían esa clave. 0 = no existe · 2+ = clave duplicada, no se escribió nada. */
  filas: number;
  /** Si quedó el acta. Puede ser false con `ok: true`: el parámetro se guardó y la auditoría
   *  no. La pantalla tiene que decirlo — callarlo sería prometer una trazabilidad que no hay. */
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

  // 3 · EL ACTA. Solo aquí, y solo porque se escribió exactamente una fila. Insertarla antes
  //     dejaría en el historial un cambio que no ocurrió, que es peor que no tener historial.
  const { error: errActa } = await sb.from("historial_costos").insert({
    tabla_origen: TABLA,
    tipo_vehiculo: clave,
    campo_modificado: e.acta.campo_modificado,
    valor_anterior: e.acta.valor_anterior,
    valor_nuevo: e.acta.valor_nuevo,
    motivo: e.acta.motivo,
    cambiado_por: e.por,
  });

  return {
    ok: true,
    filas: 1,
    acta: !errActa,
    error: errActa
      ? `El parámetro se guardó, pero no quedó registrado en el historial: ${errActa.message}`
      : undefined,
  };
}
