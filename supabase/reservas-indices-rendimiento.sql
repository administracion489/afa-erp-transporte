-- Índices para acelerar la carga de /programacion (carga acotada por ventana de fechas).
--
-- Contexto: la página dejó de traer TODAS las reservas con select("*"). Ahora la lista pide
-- solo una ventana de fechas (filtro server-side por fecha_servicio, orden fecha desc + id
-- desc, paginado por count) y varias acciones consultan por cotizacion_id / lote / vinculada.
-- Estos índices evitan que Postgres haga seq-scan de toda la tabla en esas consultas.
--
-- Seguro de correr varias veces (IF NOT EXISTS). CONCURRENTLY para no bloquear la tabla en
-- producción; por eso cada CREATE va en su propia sentencia (CONCURRENTLY no corre dentro de
-- una transacción — si tu editor SQL envuelve todo en BEGIN/COMMIT, quita CONCURRENTLY o
-- corre cada línea por separado).

-- Ventana + orden de la lista (cubre el filtro por rango de fecha_servicio y el ORDER BY).
create index concurrently if not exists idx_reservas_fecha_id
  on reservas (fecha_servicio desc, id desc);

-- "Aplicar config a rango" y la carga de números de cotización: filtran por cotizacion_id.
create index concurrently if not exists idx_reservas_cotizacion
  on reservas (cotizacion_id);

-- "Deshacer" un Programa fijo: busca por lote_generacion.
create index concurrently if not exists idx_reservas_lote
  on reservas (lote_generacion);

-- Borrado en grupo: expande y limpia la pareja IDA/RETORNO por reserva_vinculada_id.
create index concurrently if not exists idx_reservas_vinculada
  on reservas (reserva_vinculada_id);

-- Filtro por estado (usado hoy en cliente; deja listo el terreno si se mueve a server-side).
create index concurrently if not exists idx_reservas_estado
  on reservas (estado);
