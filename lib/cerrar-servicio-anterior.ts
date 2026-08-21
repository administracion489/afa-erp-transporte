// lib/cerrar-servicio-anterior.ts
//
// Un vehículo no puede estar haciendo dos rutas a la vez. Cuando arranca un servicio, si el
// MISMO vehículo tiene otro todavía en "en_curso", ese otro terminó — con certeza física, no
// por inferencia. Es la señal más fuerte que existe para cerrar un servicio abandonado, y la
// única que no depende de un reloj ni de la cobertura del GPS.
//
// POR QUÉ HACE FALTA: la reserva solo vuelve a "finalizada" cuando el conductor la cierra. Si
// no lo hace (batería, app cerrada, olvido) queda abierta indefinidamente y secuestra la app
// del pasajero, que le muestra la posición congelada de aquel viaje. Caso real del 21-ago:
// BYE-138 dejó abierto el servicio del día 20 a las 17:00; a la mañana siguiente ese mismo bus
// arrancó otro servicio y la pasajera seguía viendo el bus de la víspera ("hace 687 min").
// Con esta regla, aquel arranque habría cerrado el anterior en el acto.
//
// LO QUE **NO** HACE: no cierra por tiempo transcurrido ni por silencio del GPS. Sin la
// contradicción "arrancó otro", no toca nada — un servicio que sigue abierto porque de verdad
// sigue en ruta no debe cerrarse jamás.

/** Cierra los `en_curso` que hayan quedado abiertos para el mismo vehículo. */
export async function cerrarServiciosAnterioresDelVehiculo(
  admin: any,
  opts: { reservaIdNueva: number; vehiculoId?: number | null; vehiculoTerceroId?: number | null },
): Promise<number> {
  const { reservaIdNueva, vehiculoId, vehiculoTerceroId } = opts;
  // Sin vehículo identificado no hay contradicción que probar: mejor no tocar nada.
  if (!vehiculoId && !vehiculoTerceroId) return 0;

  try {
    let q = admin.from("reservas").select("id").eq("estado", "en_curso").neq("id", reservaIdNueva);
    // Los ids se solapan entre `vehiculos` y `vehiculos_tercero`: hay que filtrar por la
    // columna correcta o se cerrarían servicios de OTRO bus con el mismo número.
    q = vehiculoTerceroId
      ? q.eq("vehiculo_tercero_id", vehiculoTerceroId)
      : q.eq("vehiculo_id", vehiculoId);

    const { data: abiertas, error } = await q;
    if (error || !abiertas?.length) return 0;

    const ids = abiertas.map((r: any) => r.id);
    const { error: errUpd } = await admin
      .from("reservas").update({ estado: "finalizada" })
      .in("id", ids)
      .eq("estado", "en_curso");   // no pisar un cambio hecho entre el SELECT y el UPDATE
    if (errUpd) {
      console.warn("[cerrar-servicio-anterior] no se pudo cerrar:", errUpd.message);
      return 0;
    }
    console.info(`[cerrar-servicio-anterior] reserva ${reservaIdNueva} arrancó → cerrados ${ids.join(", ")}`);
    return ids.length;
  } catch (e: any) {
    // Nunca romper el inicio del servicio por esto: el conductor tiene que poder arrancar.
    console.warn("[cerrar-servicio-anterior]", e?.message);
    return 0;
  }
}
