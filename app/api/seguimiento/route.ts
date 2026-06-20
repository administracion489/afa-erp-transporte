import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Token requerido" }, { status: 400 });

  const supabase = adminClient();

  // 1. Buscar reserva por token — SELECT * para que sea robusto ante cambios de esquema
  const { data: reserva, error: errR } = await supabase
    .from("reservas")
    .select("*")
    .eq("token_seguimiento", token)
    .maybeSingle();

  if (errR) {
    console.error("[seguimiento] error SELECT reservas:", errR.message);
    return NextResponse.json({ error: "Error consultando reserva: " + errR.message }, { status: 500 });
  }
  if (!reserva) {
    return NextResponse.json({ error: "Link inválido o expirado" }, { status: 404 });
  }

  if (reserva.token_expira_at && new Date(reserva.token_expira_at) < new Date()) {
    return NextResponse.json({ error: "Este link ha expirado" }, { status: 410 });
  }

  // 2. Vehículo (propio o tercero)
  let vehiculoData: Record<string, unknown> | null = null;
  if (reserva.vehiculo_id) {
    const { data } = await supabase
      .from("vehiculos")
      .select("placa, marca, modelo, color, categoria")
      .eq("id", reserva.vehiculo_id)
      .maybeSingle();
    vehiculoData = data;
  } else if (reserva.vehiculo_tercero_id) {
    // SELECT * porque vehiculos_tercero puede no tener todas las columnas que vehiculos sí tiene
    const { data } = await supabase
      .from("vehiculos_tercero")
      .select("*")
      .eq("id", reserva.vehiculo_tercero_id)
      .maybeSingle();
    vehiculoData = data;
  }

  // 3. Conductor (propio o tercero)
  let conductorData: Record<string, unknown> | null = null;
  if (reserva.conductor_id) {
    const { data } = await supabase
      .from("conductores")
      .select("nombre, telefono")
      .eq("id", reserva.conductor_id)
      .maybeSingle();
    conductorData = data;
  } else if (reserva.conductor_tercero_id) {
    const { data } = await supabase
      .from("conductores_tercero")
      .select("nombre, telefono")
      .eq("id", reserva.conductor_tercero_id)
      .maybeSingle();
    conductorData = data;
  }

  // 3b. Empresa tercerizada (si aplica)
  let empresaData: Record<string, unknown> | null = null;
  if (reserva.empresa_tercerizada_id) {
    const { data } = await supabase
      .from("empresas_tercerizadas")
      .select("razon_social, telefono")
      .eq("id", reserva.empresa_tercerizada_id)
      .maybeSingle();
    empresaData = data;
  }

  // 4. Paradas
  const { data: paradas } = await supabase
    .from("paradas")
    .select("id, orden, nombre, direccion, lat, lng, hora_estimada, estado")
    .eq("reserva_id", reserva.id)
    .order("orden");

  // 5. Última ubicación GPS — buscar por reserva_id primero (conductor-tercero),
  //    luego por vehiculo_id (conductor propio). Así funciona con o sin vehículo asignado.
  let ultimaUbicacion = null;

  const { data: ubPorReserva } = await supabase
    .from("ubicaciones_gps")
    .select("lat, lng, velocidad, rumbo, estado, created_at")
    .eq("reserva_id", reserva.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (ubPorReserva) {
    ultimaUbicacion = ubPorReserva;
  } else {
    // Fallback: el registro GPS puede no tener reserva_id. Ramificar por columna
    // correcta — los IDs se solapan entre vehiculos y vehiculos_tercero, así que
    // un id de tercero NO debe buscarse dentro de la columna vehiculo_id.
    // IMPORTANTE: con la función "Conectarse" (estilo Uber) el conductor emite su
    // posición SIN reserva (estado "disponible") antes/después del servicio. El
    // pasajero NO debe ver al móvil en modo conectado-libre ni una posición rancia
    // de un servicio anterior del mismo vehículo: excluimos "disponible" y acotamos
    // a los últimos 15 min. (Durante el servicio real el punto SÍ lleva reserva_id,
    // así que lo cubre la consulta primaria de arriba.)
    const hace15min = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    let query = supabase
      .from("ubicaciones_gps")
      .select("lat, lng, velocidad, rumbo, estado, created_at")
      .neq("estado", "disponible")
      .gte("created_at", hace15min)
      .order("created_at", { ascending: false })
      .limit(1);

    let aplicaFallback = true;
    if (reserva.vehiculo_tercero_id) {
      query = query.eq("vehiculo_tercero_id", reserva.vehiculo_tercero_id);
    } else if (reserva.vehiculo_id) {
      query = query.eq("vehiculo_id", reserva.vehiculo_id);
    } else {
      aplicaFallback = false;
    }

    if (aplicaFallback) {
      const { data: ubPorVehiculo } = await query.maybeSingle();
      ultimaUbicacion = ubPorVehiculo;
    }
  }

  return NextResponse.json({
    reserva: { ...reserva, vehiculo: vehiculoData, conductor: conductorData, empresa: empresaData },
    paradas: paradas ?? [],
    ultimaUbicacion,
  });
}
